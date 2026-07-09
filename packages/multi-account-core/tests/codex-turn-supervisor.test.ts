import { describe, expect, test } from "vitest";
import {
  CODEX_STARTUP_PROBE_MAX_BYTES,
  superviseCodexResponseStartup,
} from "../src/adapters/codex-responses";

function chunkedSse(chunks: string[], onCancel?: () => void): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
    cancel() {
      onCancel?.();
    },
  }), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Codex turn supervisor", () => {
  test("captures a chunk-split startup quota failure before committing lifecycle events", async () => {
    let cancelled = false;
    const response = chunkedSse([
      "event: response.created\rdata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_a\"}}\r\r",
      "event: response.in_progress\rdata: {\"type\":\"response.in_progress\"}\r\r",
      "event: response.failed\rdata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"usage_limit_",
      "reached\",\"message\":\"usage limit reached\"}}}\r\r",
    ], () => {
      cancelled = true;
    });

    const result = await superviseCodexResponseStartup(response);

    expect(result.failure).toMatchObject({
      class: "rate_limit",
      code: "usage_limit_reached",
      phase: "startup",
      retryScope: "next_account",
    });
    expect(result.downstreamVisible).toBe(false);
    expect(result.response.status).toBe(429);
    expect(await result.response.text()).not.toContain("resp_a");
    expect(cancelled).toBe(true);
  });

  test("commits the original stream once meaningful output starts", async () => {
    const original = [
      "event: response.created\r\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_a\"}}\r\n\r\n",
      "event: response.output_text.delta\r\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"visible\"}\r\n\r\n",
      "event: response.failed\r\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"usage_limit_reached\"}}}\r\n\r\n",
    ];

    const result = await superviseCodexResponseStartup(chunkedSse(original));

    expect(result.failure).toBeUndefined();
    expect(result.downstreamVisible).toBe(true);
    expect(await result.response.text()).toBe(original.join(""));
  });

  test("fails closed when the pre-output buffer limit is reached", async () => {
    let cancelled = false;
    const oversizedPrelude = `: ${"x".repeat(CODEX_STARTUP_PROBE_MAX_BYTES)}\n\n`;
    const response = chunkedSse([
      oversizedPrelude,
      "event: response.failed\ndata: {\"type\":\"response.failed\",\"response\":{\"error\":{\"code\":\"usage_limit_reached\"}}}\n\n",
    ], () => {
      cancelled = true;
    });

    const result = await superviseCodexResponseStartup(response);

    expect(result.failure).toMatchObject({
      class: "transient",
      code: "startup_buffer_limit_exceeded",
      phase: "startup",
      retryScope: "same_account",
    });
    expect(result.downstreamVisible).toBe(false);
    expect(await result.response.text()).not.toContain("usage_limit_reached");
    expect(cancelled).toBe(true);
  });
});
