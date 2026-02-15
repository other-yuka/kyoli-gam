import {
  ANTHROPIC_OAUTH_ADAPTER,
  ANTHROPIC_PROFILE_ENDPOINT,
  ANTHROPIC_USAGE_ENDPOINT,
  PLAN_LABELS,
} from "./constants";
import { formatWaitTime } from "./utils";
import * as v from "valibot";
import { UsageLimitsSchema } from "./types";
import type { ManagedAccount, UsageLimits } from "./types";

const OAUTH_BETA_HEADER = ANTHROPIC_OAUTH_ADAPTER.oauthBetaHeader;

const ProfileResponseSchema = v.object({
  account: v.object({
    email: v.optional(v.string()),
    has_claude_pro: v.optional(v.boolean(), false),
    has_claude_max: v.optional(v.boolean(), false),
  }),
});

export type ProfileData = {
  email?: string;
  planTier: string;
};

export type FetchUsageResult =
  | { ok: true; data: UsageLimits }
  | { ok: false; reason: string };

export type FetchProfileResult =
  | { ok: true; data: ProfileData }
  | { ok: false; reason: string };

export async function fetchUsage(accessToken: string): Promise<FetchUsageResult> {
  try {
    const response = await fetch(ANTHROPIC_USAGE_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
      },
    });

    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status} ${response.statusText}` };
    }

    const result = v.safeParse(UsageLimitsSchema, await response.json());
    if (!result.success) {
      return { ok: false, reason: `Invalid response: ${result.issues[0]?.message ?? "unknown"}` };
    }

    return { ok: true, data: result.output };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return { ok: false, reason: message };
  }
}

export async function fetchProfile(accessToken: string): Promise<FetchProfileResult> {
  try {
    const response = await fetch(ANTHROPIC_PROFILE_ENDPOINT, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "anthropic-beta": OAUTH_BETA_HEADER,
      },
    });

    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status} ${response.statusText}` };
    }

    const result = v.safeParse(ProfileResponseSchema, await response.json());
    if (!result.success) {
      return { ok: false, reason: `Invalid response: ${result.issues[0]?.message ?? "unknown"}` };
    }

    const planTier = result.output.account.has_claude_max ? "max"
      : result.output.account.has_claude_pro ? "pro"
      : "free";

    return { ok: true, data: { email: result.output.account.email, planTier } };
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
  if (!account.cachedUsage) return "no data";

  const parts: string[] = [];
  const { five_hour, seven_day } = account.cachedUsage;

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

  return parts.length > 0 ? parts.join(", ") : "no data";
}

export function getPlanLabel(account: ManagedAccount): string {
  if (!account.planTier || account.planTier === "free") return "";
  return PLAN_LABELS[account.planTier]
    ?? account.planTier.charAt(0).toUpperCase() + account.planTier.slice(1);
}
