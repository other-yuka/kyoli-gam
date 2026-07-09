import type { AccountExecutionTraceEvent, AccountStore } from "@kyoli-gam/core";
import { StickyAccountPool } from "@kyoli-gam/core";
import { createGateway } from "@kyoli-gam/gateway";
import {
  createClaudeCodeProvider,
  isClaudeCodeNonSubscriptionBillingClaim,
} from "@kyoli-gam/provider-claude-code";
import type { CliConfig } from "./config";

type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
}

export interface DoctorReport {
  name: string;
  summary: Record<DoctorStatus, number>;
  checks: DoctorCheck[];
}

export interface ClaudeBillingClaimDoctorOptions {
  model?: string;
  fetch?: typeof fetch;
}

export function getClaudeBillingClaimDoctorExitCode(report: DoctorReport): number {
  if (report.summary.fail > 0) return 1;
  return report.summary.warn > 0 ? 2 : 0;
}

export async function runClaudeBillingClaimDoctor(
  store: AccountStore,
  config: CliConfig,
  options: ClaudeBillingClaimDoctorOptions = {},
): Promise<DoctorReport> {
  const model = options.model ?? "anthropic/claude-opus-4-8";
  const trace: AccountExecutionTraceEvent[] = [];
  const accounts = await store.listByProvider("claude-code");
  const pool = new StickyAccountPool(store, {
    strategy: config.accountSelectionStrategy,
    softQuotaThresholdPercent: config.softQuotaThresholdPercent,
    planWeights: config.planWeights,
  });
  const gateway = createGateway({
    accounts: store,
    providers: [
      createClaudeCodeProvider({
        accounts: pool,
        allowLiveMessages: true,
        fetch: options.fetch,
        onTrace: (event) => trace.push(event),
      }),
    ],
  });
  const response = await gateway.fetch(new Request("http://127.0.0.1:2021/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 16,
      messages: [{ role: "user", content: "Reply with ok." }],
    }),
  }));
  const payload = await response.clone().json().catch(() => undefined) as Record<string, unknown> | undefined;

  const claim = response.headers.get("anthropic-ratelimit-unified-representative-claim") ?? "unknown";
  const status = response.headers.get("anthropic-ratelimit-unified-status") ?? "unknown";
  const selected = trace.filter((event) => event.type === "selected");
  const responseEvents = trace.filter((event) => event.type === "response");
  const billingClaimFailures = responseEvents.filter(
    (event) => event.failureCode === "non_subscription_billing_claim",
  );
  const billingClaimStatus = classifyBillingClaim(claim);
  const requestedModel = stripProviderPrefix(model);
  const servedModel = typeof payload?.model === "string" ? payload.model : "";
  const modelCheck = checkServedModel(requestedModel, servedModel);
  const billingClaimClassification = billingClaimFailures.length > 0 || billingClaimStatus === "fail"
    ? "non_subscription"
    : billingClaimStatus === "pass"
      ? "subscription"
      : "unknown";
  const billingClaimDetail = [
    `classification=${billingClaimClassification}`,
    billingClaimStatus === "pass" ? undefined : `claim=${claim}`,
    `status=${status}`,
    billingClaimFailures.length > 0 ? "blocked_non_subscription_claim=true" : undefined,
  ].filter(Boolean).join(" ");
  const checks: DoctorCheck[] = [
    check("account inventory", accounts.length > 0, accounts.length > 0 ? "available" : "none"),
    check("account selected", selected.length > 0, selected.length > 0 ? "selected" : "none"),
    check("http status", response.status < 500, `status=${response.status}`),
    checkBillingClaim(billingClaimStatus, billingClaimFailures.length, billingClaimDetail),
    modelCheck,
  ];

  return { name: "claude-billing-claim", summary: summarizeChecks(checks), checks };
}

function check(name: string, ok: boolean, detail: string): DoctorCheck {
  return { name, status: ok ? "pass" : "fail", detail };
}

function checkBillingClaim(
  billingClaimStatus: DoctorStatus,
  failureCount: number,
  detail: string,
): DoctorCheck {
  return {
    name: "billing claim",
    status: failureCount > 0 ? "fail" : billingClaimStatus,
    detail,
  };
}

function classifyBillingClaim(claim: string): DoctorStatus {
  const normalized = claim.toLowerCase();
  if (["five_hour", "seven_day", "five_hour_fallback", "seven_day_fallback"].includes(normalized)) {
    return "pass";
  }
  return isClaudeCodeNonSubscriptionBillingClaim(normalized) ? "fail" : "warn";
}

function summarizeChecks(checks: DoctorCheck[]): DoctorReport["summary"] {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
}

function checkServedModel(requestedModel: string, servedModel: string): DoctorCheck {
  if (!servedModel) {
    return {
      name: "served model",
      status: "warn",
      detail: `requested=${requestedModel} served=unknown`,
    };
  }

  return {
    name: "served model",
    status: servedModelMatches(requestedModel, servedModel) ? "pass" : "fail",
    detail: `requested=${requestedModel} served=${servedModel}`,
  };
}

function servedModelMatches(requestedModel: string, servedModel: string): boolean {
  const requested = stripContextTag(requestedModel).toLowerCase();
  const served = stripContextTag(servedModel).toLowerCase();
  if (served.startsWith(requested)) return true;
  if (requested === "opus" || requested === "opus1m") return served.startsWith("claude-opus-");
  if (requested === "sonnet" || requested === "sonnet1m") return served.startsWith("claude-sonnet-");
  if (requested === "fable" || requested === "fable1m") return served.startsWith("claude-fable-");
  return false;
}

function stripContextTag(model: string): string {
  return model.replace(/\[1m\]$/i, "");
}

function stripProviderPrefix(model: string): string {
  const slash = model.indexOf("/");
  return slash === -1 ? model : model.slice(slash + 1);
}
