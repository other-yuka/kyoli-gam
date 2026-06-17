import { describe, expect, it } from "vitest";
import { needsResetCreditAccountIdRefresh } from "../src/auth-handler";
import { buildFakeJwt } from "./helpers";

describe("reset credit auth handling", () => {
  it("refreshes identity when a reset-credit account lacks a usable account id", () => {
    expect(needsResetCreditAccountIdRefresh({
      accessToken: "opaque-valid-access-token",
    })).toBe(true);
  });

  it("keeps existing access tokens when the account id can already be resolved", () => {
    expect(needsResetCreditAccountIdRefresh({
      accountId: "acct_stored",
      accessToken: "opaque-valid-access-token",
    })).toBe(false);

    expect(needsResetCreditAccountIdRefresh({
      accessToken: buildFakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_jwt" } }),
    })).toBe(false);
  });
});
