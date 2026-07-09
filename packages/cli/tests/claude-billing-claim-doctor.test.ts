import { describe, expect, it, vi } from "vitest";
import { MemoryAccountStore } from "@kyoli-gam/core";
import type { CliConfig } from "../src/config";
import {
  getClaudeBillingClaimDoctorExitCode,
  runClaudeBillingClaimDoctor,
} from "../src/claude-billing-claim-doctor";

const config: CliConfig = {
  accountSelectionStrategy: "round-robin",
  softQuotaThresholdPercent: 95,
  planWeights: { max: 3, pro: 2, free: 1 },
};

describe("runClaudeBillingClaimDoctor", () => {
  it("passes when Claude Code returns a subscription billing claim", async () => {
    const store = await createClaudeStore();
    const fetchImpl = createClaudeFetch("five_hour");

    const report = await runClaudeBillingClaimDoctor(store, config, { fetch: fetchImpl });

    expect(report.summary.fail).toBe(0);
    const billingClaim = report.checks.find((check) => check.name === "billing claim");
    expect(billingClaim).toMatchObject({ status: "pass" });
    expect(billingClaim?.detail).toContain("classification=subscription");
    expect(billingClaim?.detail).not.toContain("claim=five_hour");
    expect(billingClaim?.detail).toContain("status=allowed");
  });

  it("redacts account and utilization metadata", async () => {
    const store = await createClaudeStore(2);
    const fetchImpl = createSequencedClaudeFetch(["overage", "five_hour"]);

    const report = await runClaudeBillingClaimDoctor(store, config, { fetch: fetchImpl });
    const serialized = JSON.stringify(report);

    expect(report.checks.find((check) => check.name === "account inventory")?.detail).toBe("available");
    expect(report.checks.find((check) => check.name === "account selected")?.detail).toBe("selected");
    expect(serialized).not.toMatch(/account-uuid|device-id|access-token|fallback_pct|util_5h|0\.08/);
  });

  it("does not send kyoli routing headers in the canary upstream request", async () => {
    const store = await createClaudeStore();
    const captures: Headers[] = [];
    const fetchImpl = createClaudeFetch("five_hour", { captures });

    const report = await runClaudeBillingClaimDoctor(store, config, { fetch: fetchImpl });

    expect(report.summary.fail).toBe(0);
    expect(captures).toHaveLength(1);
    expect(captures[0]?.get("x-kyoli-session-id")).toBeNull();
    expect(captures[0]?.get("x-codex-session-id")).toBeNull();
    expect(captures[0]?.get("x-client-session-id")).toBeNull();
    expect(captures[0]?.get("session-id")).toBeNull();
  });

  it("warns when Claude Code returns an unknown billing claim", async () => {
    const store = await createClaudeStore();
    const fetchImpl = createClaudeFetch("mystery_bucket");

    const report = await runClaudeBillingClaimDoctor(store, config, { fetch: fetchImpl });

    expect(report.summary.fail).toBe(0);
    expect(report.summary.warn).toBeGreaterThan(0);
    expect(getClaudeBillingClaimDoctorExitCode(report)).toBe(2);
    const billingClaim = report.checks.find((check) => check.name === "billing claim");
    expect(billingClaim).toMatchObject({ status: "warn" });
    expect(billingClaim?.detail).toContain("claim=mystery_bucket");
  });

  it("returns exit code 1 when the billing claim doctor fails", async () => {
    const store = await createClaudeStore();
    const fetchImpl = createClaudeFetch("overage");

    const report = await runClaudeBillingClaimDoctor(store, config, { fetch: fetchImpl });

    expect(getClaudeBillingClaimDoctorExitCode(report)).toBe(1);
  });

  it("fails when Claude Code returns a non-subscription billing claim", async () => {
    const store = await createClaudeStore();
    const fetchImpl = createClaudeFetch("overage");

    const report = await runClaudeBillingClaimDoctor(store, config, { fetch: fetchImpl });

    expect(report.summary.fail).toBeGreaterThan(0);
    const billingClaim = report.checks.find((check) => check.name === "billing claim");
    expect(billingClaim).toMatchObject({ status: "fail" });
    expect(billingClaim?.detail).toContain("claim=overage");
    expect(billingClaim?.detail).toContain("status=blocked");
  });

  it("fails when failover would otherwise hide a non-subscription billing claim", async () => {
    const store = await createClaudeStore(2);
    const fetchImpl = createSequencedClaudeFetch(["overage", "five_hour"]);

    const report = await runClaudeBillingClaimDoctor(store, config, { fetch: fetchImpl });

    const billingClaim = report.checks.find((check) => check.name === "billing claim");
    expect(billingClaim).toMatchObject({ status: "fail" });
    expect(billingClaim?.detail).toContain("classification=non_subscription");
    expect(billingClaim?.detail).toContain("blocked_non_subscription_claim=true");
    expect(billingClaim?.detail).not.toContain("claim=five_hour");
  });

  it("fails when the served model is downgraded", async () => {
    const store = await createClaudeStore();
    const fetchImpl = createClaudeFetch("five_hour", { servedModel: "claude-haiku-4-5" });

    const report = await runClaudeBillingClaimDoctor(store, config, { fetch: fetchImpl });

    const servedModel = report.checks.find((check) => check.name === "served model");
    expect(servedModel).toMatchObject({
      status: "fail",
      detail: "requested=claude-opus-4-8 served=claude-haiku-4-5",
    });
  });
});

async function createClaudeStore(count = 1): Promise<MemoryAccountStore> {
  const store = new MemoryAccountStore();
  for (let index = 0; index < count; index += 1) {
    await store.create({
      provider: "claude-code",
      kind: "oauth",
      name: `Claude test ${index + 1}`,
      credentials: {
        accessToken: `access-token-${index + 1}`,
        expiresAt: Date.now() + 3_600_000,
      },
      metadata: {
        accountId: `account-uuid-${index + 1}`,
        deviceId: `device-id-${index + 1}`,
      },
    });
  }
  return store;
}

function createClaudeFetch(
  claim: string,
  options: { captures?: Headers[]; servedModel?: string } = {},
): typeof fetch {
  return createSequencedClaudeFetch([claim], options);
}

function createSequencedClaudeFetch(
  claims: string[],
  options: { captures?: Headers[]; servedModel?: string } = {},
): typeof fetch {
  let requestCount = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/v1/models")) {
      return new Response("{}", { status: 500 });
    }

    options.captures?.push(new Headers(init?.headers));
    const claim = claims[Math.min(requestCount, claims.length - 1)] ?? "five_hour";
    requestCount += 1;
    return new Response(JSON.stringify({
      id: "msg_test",
      type: "message",
      model: options.servedModel ?? "claude-opus-4-8",
    }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "anthropic-ratelimit-unified-representative-claim": claim,
        "anthropic-ratelimit-unified-status": claim === "overage" ? "blocked" : "allowed",
        "anthropic-ratelimit-unified-fallback-percentage": "0.5",
        "anthropic-ratelimit-unified-5h-utilization": "0.08",
      },
    });
  }) as typeof fetch;
}
