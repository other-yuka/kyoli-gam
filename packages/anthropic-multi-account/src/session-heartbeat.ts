import { getUpstreamSessionId } from "./upstream-request";
import { loadCCDerivedRequestProfile } from "./cc-derived-profile";
import { getAnthropicVersion } from "./upstream-headers";

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const CLIENT_PLATFORM = "cli";

interface HeartbeatOptions {
  sessionId: string;
  deviceId: string;
  accessToken: string;
  intervalMs?: number;
}

interface HeartbeatHandle {
  stop(): void;
}

interface HeartbeatTestOverrides {
  fetch?: typeof globalThis.fetch;
  onStart?: (options: HeartbeatOptions) => void;
}

let testOverrides: HeartbeatTestOverrides = {};

function presenceUrl(sessionId: string): string {
  return `${loadCCDerivedRequestProfile().baseApiUrl}/v1/code/sessions/${sessionId}/client/presence`;
}

function fetchFn(): typeof globalThis.fetch {
  return testOverrides.fetch ?? globalThis.fetch;
}

export function startHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  testOverrides.onStart?.(options);

  const {
    sessionId,
    deviceId,
    accessToken,
    intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  } = options;

  let activeController: AbortController | null = null;
  let stopped = false;

  const sendPresence = async (): Promise<void> => {
    if (stopped) return;

    const controller = new AbortController();
    activeController = controller;

    try {
      await fetchFn()(presenceUrl(sessionId), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "anthropic-version": getAnthropicVersion(),
          "anthropic-client-platform": CLIENT_PLATFORM,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: deviceId,
          connected_at: new Date().toISOString(),
        }),
        signal: controller.signal,
      });
    } catch {
      // Intentional silent catch: the presence endpoint is undocumented
      // and heartbeat failures must never propagate to callers.
    } finally {
      if (activeController === controller) {
        activeController = null;
      }
    }
  };

  const timer = setInterval(sendPresence, intervalMs);

  if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") {
    timer.unref();
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      activeController?.abort();
      activeController = null;
    },
  };
}

export function getSessionId(): string {
  return getUpstreamSessionId();
}

export { DEFAULT_HEARTBEAT_INTERVAL_MS };

export function setHeartbeatTestOverridesForTest(overrides: HeartbeatTestOverrides | null): void {
  testOverrides = overrides ?? {};
}

export function resetHeartbeatForTest(): void {
  testOverrides = {};
}
