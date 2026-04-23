import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  resetUpstreamRequestForTest,
  setUpstreamRequestTestOverridesForTest,
} from "../src/request/upstream-request";
import {
  getSessionId,
  resetHeartbeatForTest,
  setHeartbeatTestOverridesForTest,
  startHeartbeat,
} from "../src/session-heartbeat";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  resetHeartbeatForTest();
  resetUpstreamRequestForTest();
});

describe("session-heartbeat", () => {
  test("heartbeat sends POST with correct URL, headers, and body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];

    const mockFetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    setHeartbeatTestOverridesForTest({ fetch: mockFetch });

    const handle = startHeartbeat({
      sessionId: "s1",
      deviceId: "d1",
      accessToken: "tok",
      intervalMs: 50,
    });

    await sleep(80);
    handle.stop();

    expect(calls.length).toBeGreaterThanOrEqual(1);

    const first = calls[0]!;
    expect(first.url).toBe(
      "https://api.anthropic.com/v1/code/sessions/s1/client/presence",
    );
    expect(first.init.method).toBe("POST");

    const headers = first.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-client-platform"]).toBe("cli");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(first.init.body as string) as {
      client_id: string;
      connected_at: string;
    };
    expect(body.client_id).toBe("d1");
    expect(typeof body.connected_at).toBe("string");
    expect(() => new Date(body.connected_at)).not.toThrow();
  });

  test("stop clears interval and prevents further fetch calls", async () => {
    let callCount = 0;

    const mockFetch = mock(async () => {
      callCount++;
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    setHeartbeatTestOverridesForTest({ fetch: mockFetch });

    const handle = startHeartbeat({
      sessionId: "s1",
      deviceId: "d1",
      accessToken: "tok",
      intervalMs: 50,
    });

    await sleep(80);
    const countAfterFirstTick = callCount;
    expect(countAfterFirstTick).toBeGreaterThanOrEqual(1);

    handle.stop();

    await sleep(120);
    expect(callCount).toBe(countAfterFirstTick);
  });

  test("stop is idempotent", async () => {
    const mockFetch = mock(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof globalThis.fetch;

    setHeartbeatTestOverridesForTest({ fetch: mockFetch });

    const handle = startHeartbeat({
      sessionId: "s1",
      deviceId: "d1",
      accessToken: "tok",
      intervalMs: 50,
    });

    handle.stop();
    expect(() => handle.stop()).not.toThrow();
  });

  test("stop aborts in-flight fetch", async () => {
    const signals: AbortSignal[] = [];

    const mockFetch = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.signal) signals.push(init.signal);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(resolve, 5_000);
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timeout);
          reject(init.signal?.reason);
        });
      });
      return new Response(null, { status: 200 });
    }) as unknown as typeof globalThis.fetch;

    setHeartbeatTestOverridesForTest({ fetch: mockFetch });

    const handle = startHeartbeat({
      sessionId: "s1",
      deviceId: "d1",
      accessToken: "tok",
      intervalMs: 50,
    });

    await sleep(80);
    expect(signals.length).toBeGreaterThanOrEqual(1);

    handle.stop();

    const lastSignal = signals[signals.length - 1]!;
    expect(lastSignal.aborted).toBe(true);
  });

  test("fetch failure is silent and non-fatal", async () => {
    let callCount = 0;

    const mockFetch = mock(async () => {
      callCount++;
      throw new Error("Network failure");
    }) as unknown as typeof globalThis.fetch;

    setHeartbeatTestOverridesForTest({ fetch: mockFetch });

    const handle = startHeartbeat({
      sessionId: "s1",
      deviceId: "d1",
      accessToken: "tok",
      intervalMs: 50,
    });

    await sleep(130);
    handle.stop();

    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  test("session ID rotates after 15-minute idle", () => {
    let currentTime = 1_000_000;
    let sessionCounter = 0;
    const sessionIds = ["session-original", "session-rotated"];

    setUpstreamRequestTestOverridesForTest({
      now: () => currentTime,
      createSessionId: () => sessionIds[sessionCounter++] ?? "session-fallback",
    });

    const first = getSessionId();
    expect(first).toBe("session-original");

    currentTime += 10 * 60 * 1_000;
    expect(getSessionId()).toBe("session-original");

    currentTime += 16 * 60 * 1_000;
    const rotated = getSessionId();
    expect(rotated).toBe("session-rotated");
    expect(rotated).not.toBe(first);
  });

  test("session ID stays stable within 15-minute window", () => {
    let currentTime = 1_000_000;
    let sessionCounter = 0;

    setUpstreamRequestTestOverridesForTest({
      now: () => currentTime,
      createSessionId: () => `session-${sessionCounter++}`,
    });

    const first = getSessionId();
    expect(first).toBe("session-0");

    for (let i = 0; i < 5; i++) {
      currentTime += 60 * 1_000;
      expect(getSessionId()).toBe("session-0");
    }
  });
});
