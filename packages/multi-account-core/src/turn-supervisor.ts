export type TurnFailureClass =
  | "rate_limit"
  | "quota"
  | "auth"
  | "permanent"
  | "transient"
  | "neutral";

export type TurnFailurePhase =
  | "connect"
  | "headers"
  | "startup"
  | "mid_stream"
  | "terminal";

export interface TurnFailureSignal {
  class: TurnFailureClass;
  phase: TurnFailurePhase;
  code?: string;
  message?: string;
  httpStatus?: number;
  metadata?: Record<string, unknown>;
  retryAfterSeconds?: number;
  resetAt?: string;
  retryScope?: "same_account" | "next_account" | "none";
}

export interface SupervisedTurnResponse {
  response: Response;
  failure?: TurnFailureSignal;
  downstreamVisible?: boolean;
}

export type TurnResponseSupervisor = (response: Response) => Promise<SupervisedTurnResponse>;

export interface SseStartupSupervisorOptions {
  maxBufferedBytes: number;
  classifyFailure(frame: string): TurnFailureSignal | undefined;
  isCommitFrame(frame: string): boolean;
  createBufferLimitFailure(bufferedBytes: number): TurnFailureSignal;
  createFailureResponse(failure: TurnFailureSignal): Response;
}

export async function superviseSseResponseStartup(
  response: Response,
  options: SseStartupSupervisorOptions,
): Promise<SupervisedTurnResponse> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (!response.ok || !response.body || !contentType?.includes("text/event-stream")) {
    return { response };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  let bufferedBytes = 0;
  let pendingText = "";
  let failure: TurnFailureSignal | undefined;
  let downstreamVisible = false;
  let done = false;

  while (!failure && !downstreamVisible) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    chunks.push(next.value);
    bufferedBytes += next.value.byteLength;
    pendingText += decoder.decode(next.value, { stream: true });
    pendingText = drainSseFrames(pendingText, inspectFrame);
    if (!failure && !downstreamVisible && bufferedBytes >= options.maxBufferedBytes) {
      failure = options.createBufferLimitFailure(bufferedBytes);
    }
  }

  if (done && !failure && !downstreamVisible) {
    pendingText += decoder.decode();
    if (pendingText.trim()) inspectFrame(pendingText);
  }

  if (failure) {
    await reader.cancel().catch(() => undefined);
    return {
      failure,
      downstreamVisible: false,
      response: options.createFailureResponse(failure),
    };
  }

  return {
    downstreamVisible,
    response: new Response(replayResponseBody(chunks, reader), {
      status: response.status,
      statusText: response.statusText,
      headers: filterStreamingResponseHeaders(response.headers),
    }),
  };

  function inspectFrame(frame: string): void {
    if (failure || downstreamVisible) return;
    failure = options.classifyFailure(frame);
    if (!failure && options.isCommitFrame(frame)) downstreamVisible = true;
  }
}

export function drainSseFrames(buffer: string, onFrame: (frame: string) => void): string {
  let remainder = buffer;
  while (true) {
    const separator = /(?:\r\n|\r|\n)(?:\r\n|\r|\n)/.exec(remainder);
    if (!separator || separator.index === undefined) return remainder;
    const frame = remainder.slice(0, separator.index);
    remainder = remainder.slice(separator.index + separator[0].length);
    if (frame.trim()) onFrame(frame);
  }
}

function replayResponseBody(
  chunks: Uint8Array[],
  reader: ReadableStreamDefaultReader<Uint8Array>,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(chunks[index++]!);
        return;
      }
      const next = await reader.read();
      if (next.done) {
        controller.close();
        return;
      }
      controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function filterStreamingResponseHeaders(headers: Headers): Headers {
  const filtered = new Headers(headers);
  filtered.delete("content-encoding");
  filtered.delete("content-length");
  filtered.delete("transfer-encoding");
  filtered.delete("connection");
  return filtered;
}
