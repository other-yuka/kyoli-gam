export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);

  return msg
    .replace(/sk-ant-[a-zA-Z0-9_-]+/g, "[REDACTED]")
    .replace(/eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/Bearer\s+[^\s,;]+/gi, "Bearer [REDACTED]");
}

export function enrich429(body: string, headers: Headers): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: {
        message?: string;
      };
    };
    const error = parsed.error;

    if (error && (error.message === "Error" || !error.message)) {
      const claim = headers.get("anthropic-ratelimit-unified-representative-claim") || "unknown";
      const status = headers.get("anthropic-ratelimit-unified-status") || "rejected";
      const util5h = headers.get("anthropic-ratelimit-unified-5h-utilization");
      const util7d = headers.get("anthropic-ratelimit-unified-7d-utilization");
      const reset = headers.get("anthropic-ratelimit-unified-reset");
      const parts = [`Rate limited (${status}). Limiting window: ${claim}`];

      if (util5h) {
        const parsedUtil5h = Number.parseFloat(util5h);
        if (Number.isFinite(parsedUtil5h)) {
          parts.push(`5h utilization: ${Math.round(parsedUtil5h * 100)}%`);
        }
      }

      if (util7d) {
        const parsedUtil7d = Number.parseFloat(util7d);
        if (Number.isFinite(parsedUtil7d)) {
          parts.push(`7d utilization: ${Math.round(parsedUtil7d * 100)}%`);
        }
      }

      if (reset) {
        const parsedReset = Number.parseInt(reset, 10);
        if (Number.isFinite(parsedReset)) {
          const resetDate = new Date(parsedReset * 1000);
          const minutesUntilReset = Math.max(0, Math.round((resetDate.getTime() - Date.now()) / 60000));
          parts.push(`resets in ${minutesUntilReset}m`);
        }
      }

      error.message = parts.join(". ");
    }

    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}
