import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CodexMultiAuthPlugin } from "../src/index";
import { setupTestEnv } from "./helpers";

let cleanup: (() => Promise<void>) | undefined;

beforeEach(async () => {
  const env = await setupTestEnv();
  cleanup = env.cleanup;
});

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe("codex multi-auth plugin", () => {
  test("loader resolves with oauth fetch wrapper", async () => {
    const plugin = await CodexMultiAuthPlugin({ client: {} as never });
    const auth = (plugin as Record<string, unknown>).auth as {
      loader: (getAuth: () => Promise<unknown>, provider: unknown) => Promise<unknown>;
    };
    const result = (await auth.loader(
      async () => ({ type: "oauth" }),
      {},
    )) as { apiKey: string; fetch: unknown };

    expect(result.apiKey).toBe("CODEX_OAUTH");
    expect(typeof result.fetch).toBe("function");
  });

  test("loader returns passthrough for non-oauth auth", async () => {
    const plugin = await CodexMultiAuthPlugin({ client: {} as never });
    const auth = (plugin as Record<string, unknown>).auth as {
      loader: (getAuth: () => Promise<unknown>, provider: unknown) => Promise<unknown>;
    };
    const result = (await auth.loader(
      async () => ({ type: "api" }),
      {},
    )) as { apiKey: string; fetch: unknown };

    expect(result.apiKey).toBe("");
    expect(typeof result.fetch).toBe("function");
  });

  test("exposes correct auth provider id", async () => {
    const plugin = await CodexMultiAuthPlugin({ client: {} as never });
    const auth = (plugin as Record<string, unknown>).auth as {
      provider: string;
    };
    expect(auth.provider).toBe("openai");
  });

  test("exposes oauth-only auth method", async () => {
    const plugin = await CodexMultiAuthPlugin({ client: {} as never });
    const auth = (plugin as Record<string, unknown>).auth as {
      methods: Array<{ label: string; type: string }>;
    };
    expect(auth.methods).toHaveLength(1);
    expect(auth.methods[0]).toMatchObject({
      label: "ChatGPT Plus/Pro (Multi-Auth)",
      type: "oauth",
    });
  });
});
