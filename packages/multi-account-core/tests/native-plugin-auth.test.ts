import { describe, expect, test, vi } from "vitest";
import { createOpenCodeNativeAuthMethods } from "../src/native-plugin-auth";

describe("createOpenCodeNativeAuthMethods", () => {
  test("creates only the oauth method", () => {
    const methods = createOpenCodeNativeAuthMethods({
      oauthLabel: "Login",
      authorize: async () => ({ ok: true }),
    });

    expect(methods).toMatchObject([
      { label: "Login", type: "oauth" },
    ]);
  });

  test("passes optional authorize inputs through", async () => {
    const authorize = vi.fn(async () => ({ ok: true }));
    const [oauth] = createOpenCodeNativeAuthMethods({
      oauthLabel: "Login",
      authorize,
    });

    if (oauth?.type !== "oauth") {
      throw new Error("Expected oauth method");
    }

    await oauth.authorize({ account: "work" });

    expect(authorize).toHaveBeenCalledWith({ account: "work" });
  });

  test("ignores non-object authorize inputs", async () => {
    const authorize = vi.fn(async () => ({ ok: true }));
    const [oauth] = createOpenCodeNativeAuthMethods({
      oauthLabel: "Login",
      authorize,
    });

    if (oauth?.type !== "oauth") {
      throw new Error("Expected oauth method");
    }

    await oauth.authorize("unexpected");

    expect(authorize).toHaveBeenCalledWith(undefined);
  });
});
