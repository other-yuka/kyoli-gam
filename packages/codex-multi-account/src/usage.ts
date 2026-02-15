import { formatWaitTime } from "./utils";
import * as v from "valibot";
import { UsageLimitsSchema } from "./types";
import { parseJwtClaims } from "./oauth";
import { CODEX_USAGE_ENDPOINT, OPENAI_CLI_USER_AGENT, PLAN_LABELS } from "./constants";
import type { ManagedAccount, UsageLimits } from "./types";

/** OpenAI JWT namespaced claim keys */
const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";
const OPENAI_PROFILE_CLAIM = "https://api.openai.com/profile";

/** Schema for the OpenAI namespaced auth claim in JWT */
const OpenAIAuthClaimSchema = v.object({
  chatgpt_plan_type: v.optional(v.string()),
  chatgpt_account_id: v.optional(v.string()),
  chatgpt_user_id: v.optional(v.string()),
});

/** Schema for the OpenAI namespaced profile claim in JWT */
const OpenAIProfileClaimSchema = v.object({
  email: v.optional(v.string()),
});

/** Schema for the WHAM usage API response from chatgpt.com */
const WhamRateLimitWindowSchema = v.object({
  used_percent: v.number(),
  reset_after_seconds: v.number(),
});

const WhamUsageResponseSchema = v.object({
  plan_type: v.optional(v.nullable(v.string())),
  rate_limit: v.optional(v.nullable(v.object({
    primary_window: v.optional(v.nullable(WhamRateLimitWindowSchema)),
    secondary_window: v.optional(v.nullable(WhamRateLimitWindowSchema)),
  }))),
  credits: v.optional(v.nullable(v.object({
    balance: v.optional(v.nullable(v.string())),
    unlimited: v.optional(v.nullable(v.boolean())),
  }))),
});

export type ProfileData = {
  email?: string;
  planTier: string;
};

export type FetchUsageResult =
  | { ok: true; data: UsageLimits; planType?: string }
  | { ok: false; reason: string };

export type FetchProfileResult =
  | { ok: true; data: ProfileData }
  | { ok: false; reason: string };

function secondsToISOResetTime(resetAfterSeconds: number): string {
  return new Date(Date.now() + resetAfterSeconds * 1000).toISOString();
}

export async function fetchUsage(accessToken: string, accountId?: string): Promise<FetchUsageResult> {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": OPENAI_CLI_USER_AGENT,
    };

    if (accountId) {
      headers["ChatGPT-Account-Id"] = accountId;
    }

    const response = await fetch(CODEX_USAGE_ENDPOINT, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status} ${response.statusText}` };
    }

    const parsed = v.safeParse(WhamUsageResponseSchema, await response.json());
    if (!parsed.success) {
      return { ok: false, reason: `Invalid response: ${parsed.issues[0]?.message ?? "unknown"}` };
    }

    const wham = parsed.output;
    const primaryWindow = wham.rate_limit?.primary_window;
    const secondaryWindow = wham.rate_limit?.secondary_window;

    const usage: UsageLimits = {
      five_hour: primaryWindow
        ? {
          utilization: primaryWindow.used_percent,
          resets_at: secondsToISOResetTime(primaryWindow.reset_after_seconds),
        }
        : null,
      seven_day: secondaryWindow
        ? {
          utilization: secondaryWindow.used_percent,
          resets_at: secondsToISOResetTime(secondaryWindow.reset_after_seconds),
        }
        : null,
      seven_day_sonnet: null,
    };

    const validated = v.safeParse(UsageLimitsSchema, usage);
    if (!validated.success) {
      return { ok: false, reason: `Mapping error: ${validated.issues[0]?.message ?? "unknown"}` };
    }

    return { ok: true, data: validated.output, planType: wham.plan_type ?? undefined };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, reason: message };
  }
}

export function derivePlanTier(planType: string): string {
  const normalized = planType.toLowerCase().trim();
  return normalized || "free";
}

export function fetchProfile(accessToken: string): FetchProfileResult {
  try {
    const claims = parseJwtClaims(accessToken);
    if (!claims || typeof claims !== "object") {
      return { ok: true, data: { planTier: "free" } };
    }

    const record = claims as Record<string, unknown>;

    // Extract email from namespaced profile claim
    const profileClaim = record[OPENAI_PROFILE_CLAIM];
    const profileParsed = v.safeParse(OpenAIProfileClaimSchema, profileClaim ?? {});
    const email = profileParsed.success ? profileParsed.output.email : undefined;

    // Extract plan_type from namespaced auth claim
    const authClaim = record[OPENAI_AUTH_CLAIM];
    const authParsed = v.safeParse(OpenAIAuthClaimSchema, authClaim ?? {});
    const planType = authParsed.success ? (authParsed.output.chatgpt_plan_type ?? "") : "";
    const planTier = derivePlanTier(planType);

    return {
      ok: true,
      data: { email, planTier },
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, reason: message };
  }
}

function formatTimeRemaining(resetAt: string | null): string {
  if (!resetAt) return "unknown";
  const diffMs = new Date(resetAt).getTime() - Date.now();
  if (diffMs <= 0) return "0m";
  return formatWaitTime(diffMs);
}

export function getUsageSummary(account: ManagedAccount): string {
  if (!account.cachedUsage) return "no usage data";

  const parsed = v.safeParse(UsageLimitsSchema, account.cachedUsage);
  if (!parsed.success) return "no usage data";

  const parts: string[] = [];
  const { five_hour, seven_day } = parsed.output;

  if (five_hour) {
    const reset = five_hour.utilization >= 100 && five_hour.resets_at
      ? ` (resets ${formatTimeRemaining(five_hour.resets_at)})`
      : "";
    parts.push(`5h: ${five_hour.utilization.toFixed(0)}%${reset}`);
  }
  if (seven_day) {
    const reset = seven_day.utilization >= 100 && seven_day.resets_at
      ? ` (resets ${formatTimeRemaining(seven_day.resets_at)})`
      : "";
    parts.push(`7d: ${seven_day.utilization.toFixed(0)}%${reset}`);
  }

  return parts.length > 0 ? parts.join(", ") : "no usage data";
}

export function getPlanLabel(account: ManagedAccount): string {
  if (!account.planTier || account.planTier === "free") return "";
  return PLAN_LABELS[account.planTier]
    ?? account.planTier.charAt(0).toUpperCase() + account.planTier.slice(1);
}
