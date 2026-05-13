import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { GatewayWebSocket, GatewayWebSocketMessage } from "@kyoli-gam/core";

export class WebSocketUpgradeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class NodeGatewayWebSocket implements GatewayWebSocket {
  #accepted = false;
  #closed = false;
  #buffer = Buffer.alloc(0);
  #queue: GatewayWebSocketMessage[] = [];
  #receivers: Array<(message: GatewayWebSocketMessage) => void> = [];

  constructor(
    private readonly socket: Socket,
    private readonly head: Buffer,
    private readonly key: string | undefined,
  ) {}

  get accepted(): boolean {
    return this.#accepted;
  }

  async accept(headers?: HeadersInit): Promise<void> {
    if (this.#accepted) return;
    if (!this.key) {
      throw new WebSocketUpgradeError(400, "Missing sec-websocket-key.");
    }

    const responseHeaders = new Headers(headers);
    responseHeaders.set("Upgrade", "websocket");
    responseHeaders.set("Connection", "Upgrade");
    responseHeaders.set("Sec-WebSocket-Accept", createAcceptKey(this.key));

    const lines = ["HTTP/1.1 101 Switching Protocols"];
    responseHeaders.forEach((value, key) => {
      lines.push(`${key}: ${value}`);
    });
    this.socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    this.#accepted = true;

    this.socket.on("data", (chunk: Buffer) => this.#onData(chunk));
    this.socket.on("end", () => this.#push({ type: "close" }));
    this.socket.on("close", () => this.#push({ type: "close" }));
    this.socket.on("error", () => this.#push({ type: "close" }));
    if (this.head.byteLength > 0) this.#onData(this.head);
  }

  async receive(): Promise<GatewayWebSocketMessage> {
    const message = this.#queue.shift();
    if (message) return message;
    if (this.#closed) return { type: "close" };
    return new Promise((resolve) => {
      this.#receivers.push(resolve);
    });
  }

  async sendText(data: string): Promise<void> {
    this.#sendFrame(0x1, Buffer.from(data));
  }

  async sendBinary(data: Uint8Array): Promise<void> {
    this.#sendFrame(0x2, Buffer.from(data));
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const reasonBytes = Buffer.from(reason);
    const payload = Buffer.allocUnsafe(2 + reasonBytes.byteLength);
    payload.writeUInt16BE(code, 0);
    reasonBytes.copy(payload, 2);
    this.#sendFrame(0x8, payload);
    this.socket.end();
    this.#flushReceivers({ type: "close", code, reason });
  }

  #onData(chunk: Buffer): void {
    try {
      this.#buffer = Buffer.concat([this.#buffer, chunk]);
      while (this.#buffer.byteLength >= 2) {
        const parsed = parseFrame(this.#buffer);
        if (!parsed) return;
        this.#buffer = this.#buffer.subarray(parsed.consumed);

        if (parsed.opcode === 0x1) {
          this.#push({ type: "text", data: parsed.payload.toString("utf8") });
        } else if (parsed.opcode === 0x2) {
          this.#push({ type: "binary", data: new Uint8Array(parsed.payload) });
        } else if (parsed.opcode === 0x8) {
          const code = parsed.payload.byteLength >= 2 ? parsed.payload.readUInt16BE(0) : undefined;
          const reason = parsed.payload.byteLength > 2 ? parsed.payload.subarray(2).toString("utf8") : undefined;
          this.#closed = true;
          if (!this.socket.destroyed) this.#sendFrame(0x8, parsed.payload);
          this.socket.end();
          this.#push({ type: "close", code, reason });
        } else if (parsed.opcode === 0x9) {
          this.#sendFrame(0xa, parsed.payload);
        }
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Invalid WebSocket frame.";
      void this.close(1002, reason);
    }
  }

  #push(message: GatewayWebSocketMessage): void {
    if (message.type === "close") this.#closed = true;
    const receiver = this.#receivers.shift();
    if (receiver) {
      receiver(message);
      return;
    }
    this.#queue.push(message);
  }

  #flushReceivers(message: GatewayWebSocketMessage): void {
    for (const receiver of this.#receivers.splice(0)) receiver(message);
  }

  #sendFrame(opcode: number, payload: Buffer): void {
    if (!this.#accepted || this.socket.destroyed) return;
    const header = createServerFrameHeader(opcode, payload.byteLength);
    this.socket.write(Buffer.concat([header, payload]));
  }
}

export function createUpgradeRequest(request: IncomingMessage): Request {
  const host = request.headers.host ?? "127.0.0.1";
  return new Request(`http://${host}${request.url ?? "/"}`, {
    method: request.method,
    headers: toWebHeaders(request.headers),
  });
}

export function writeUpgradeError(socket: Socket, status: number, message: string): void {
  const body = JSON.stringify({ error: { type: "websocket_upgrade_failed", message } });
  socket.write([
    `HTTP/1.1 ${status} ${statusText(status)}`,
    "content-type: application/json",
    `content-length: ${Buffer.byteLength(body)}`,
    "connection: close",
    "",
    body,
  ].join("\r\n"));
  socket.destroy();
}

function createAcceptKey(key: string): string {
  return createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
}

function parseFrame(buffer: Buffer): { opcode: number; payload: Buffer; consumed: number } | undefined {
  const first = buffer[0] ?? 0;
  const second = buffer[1] ?? 0;
  const opcode = first & 0x0f;
  const masked = (second & 0x80) !== 0;
  let payloadLength = second & 0x7f;
  let offset = 2;

  if (payloadLength === 126) {
    if (buffer.byteLength < offset + 2) return undefined;
    payloadLength = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (payloadLength === 127) {
    if (buffer.byteLength < offset + 8) return undefined;
    const longLength = buffer.readBigUInt64BE(offset);
    if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new WebSocketUpgradeError(1009, "WebSocket frame is too large.");
    }
    payloadLength = Number(longLength);
    offset += 8;
  }

  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.byteLength < offset + payloadLength) return undefined;

  const payload = Buffer.from(buffer.subarray(offset, offset + payloadLength));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let index = 0; index < payload.byteLength; index += 1) {
      payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
    }
  }
  return { opcode, payload, consumed: offset + payloadLength };
}

function createServerFrameHeader(opcode: number, length: number): Buffer {
  if (length < 126) {
    return Buffer.from([0x80 | opcode, length]);
  }
  if (length <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return header;
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return header;
}

function statusText(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 404) return "Not Found";
  if (status === 429) return "Too Many Requests";
  if (status === 501) return "Not Implemented";
  return "Internal Server Error";
}

function toWebHeaders(headers: IncomingMessage["headers"]): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result.set(key, value);
    } else if (Array.isArray(value)) {
      for (const item of value) result.append(key, item);
    }
  }
  return result;
}
