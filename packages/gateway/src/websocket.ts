import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { GatewayWebSocket, GatewayWebSocketMessage } from "@kyoli-gam/core";
import { WebSocketServer, type RawData, type WebSocket as WsWebSocket } from "ws";

export class WebSocketUpgradeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const responseHeadersByRequest = new WeakMap<IncomingMessage, string[]>();
const websocketServer = new WebSocketServer({
  noServer: true,
  perMessageDeflate: false,
});

websocketServer.on("headers", (headers, request) => {
  const extraHeaders = responseHeadersByRequest.get(request);
  if (extraHeaders) headers.push(...extraHeaders);
});

export class NodeGatewayWebSocket implements GatewayWebSocket {
  #accepted = false;
  #closed = false;
  #websocket: WsWebSocket | undefined;
  #queue: GatewayWebSocketMessage[] = [];
  #receivers: Array<(message: GatewayWebSocketMessage) => void> = [];

  constructor(
    private readonly request: IncomingMessage,
    private readonly socket: Socket,
    private readonly head: Buffer,
  ) {}

  get accepted(): boolean {
    return this.#accepted;
  }

  async accept(headers?: HeadersInit): Promise<void> {
    if (this.#accepted) return;
    if (!this.request.headers["sec-websocket-key"]) {
      throw new WebSocketUpgradeError(400, "Missing sec-websocket-key.");
    }

    responseHeadersByRequest.set(this.request, toResponseHeaderLines(headers));
    await new Promise<void>((resolve, reject) => {
      try {
        websocketServer.handleUpgrade(this.request, this.socket, this.head, (websocket) => {
          this.#websocket = websocket;
          this.#accepted = true;
          this.#attachWebSocket(websocket);
          resolve();
        });
      } catch (error) {
        reject(error);
      } finally {
        responseHeadersByRequest.delete(this.request);
      }
    });
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
    this.#send(data);
  }

  async sendBinary(data: Uint8Array): Promise<void> {
    this.#send(data);
  }

  async close(code = 1000, reason = ""): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#websocket && this.#websocket.readyState === this.#websocket.OPEN) {
      this.#websocket.close(code, reason);
    } else if (!this.socket.destroyed) {
      this.socket.end();
    }
    this.#flushReceivers({ type: "close", code, reason });
  }

  #attachWebSocket(websocket: WsWebSocket): void {
    websocket.on("message", (data, isBinary) => {
      const buffer = rawDataToBuffer(data);
      if (isBinary) {
        this.#push({ type: "binary", data: new Uint8Array(buffer) });
        return;
      }
      this.#push({ type: "text", data: buffer.toString("utf8") });
    });
    websocket.on("close", (code, reason) => {
      this.#push({
        type: "close",
        code,
        reason: reason.byteLength > 0 ? reason.toString("utf8") : undefined,
      });
    });
    websocket.on("error", () => {
      this.#push({ type: "close" });
    });
  }

  #push(message: GatewayWebSocketMessage): void {
    if (message.type === "close" && this.#closed) return;
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

  #send(data: string | Uint8Array): void {
    if (!this.#websocket || this.#websocket.readyState !== this.#websocket.OPEN) return;
    this.#websocket.send(data);
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

function statusText(status: number): string {
  if (status === 400) return "Bad Request";
  if (status === 404) return "Not Found";
  if (status === 429) return "Too Many Requests";
  if (status === 501) return "Not Implemented";
  return "Internal Server Error";
}

function toResponseHeaderLines(headers: HeadersInit | undefined): string[] {
  if (!headers) return [];
  const result: string[] = [];
  new Headers(headers).forEach((value, key) => {
    result.push(`${key}: ${value}`);
  });
  return result;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.concat(data);
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
