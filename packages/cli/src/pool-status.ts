import {
  summarizeAccountStatus,
  type AccountRecord,
  type ProviderId,
  type RequestLogStore,
  type StickySessionRegistry,
} from "@kyoli-gam/core";

export interface PoolStatusInput {
  accounts: AccountRecord[];
  strategy: string;
  stickySessions?: StickySessionRegistry;
  requestLogs?: RequestLogStore;
}

export interface PoolProviderStatus {
  provider: ProviderId;
  total: number;
  ready: number;
  rateLimited: number;
  authCooldown: number;
  disabled: number;
  reauthRequired: number;
  failed: number;
  stickySessions: number;
  responses: number;
  latestAt?: string;
}

export interface PoolStatus {
  total: number;
  ready: number;
  rateLimited: number;
  authCooldown: number;
  disabled: number;
  reauthRequired: number;
  failed: number;
  strategy: string;
  stickySessions: number;
  responses: number;
  latestAt?: string;
  providers: PoolProviderStatus[];
}

export function createPoolStatus(input: PoolStatusInput): PoolStatus {
  const summaries = summarizeAccountStatus(input.accounts);
  const stickySessions = input.stickySessions?.listStickySessions() ?? [];
  const requestLogs = input.requestLogs?.listRequestLogs() ?? [];
  const responseLogs = requestLogs.filter((log) => log.eventType === "response");

  return {
    total: sum(summaries, "total"),
    ready: sum(summaries, "ready"),
    rateLimited: sum(summaries, "rateLimited"),
    authCooldown: sum(summaries, "authCooldown"),
    disabled: sum(summaries, "disabled"),
    reauthRequired: sum(summaries, "reauthRequired"),
    failed: sum(summaries, "failed"),
    strategy: input.strategy,
    stickySessions: stickySessions.length,
    responses: responseLogs.length,
    latestAt: requestLogs[0]?.createdAt,
    providers: summaries.map((summary) => {
      const providerSessions = stickySessions.filter((session) => session.provider === summary.provider);
      const providerLogs = requestLogs.filter((log) => log.provider === summary.provider);
      const providerResponses = providerLogs.filter((log) => log.eventType === "response");
      return {
        provider: summary.provider,
        total: summary.total,
        ready: summary.ready,
        rateLimited: summary.rateLimited,
        authCooldown: summary.authCooldown,
        disabled: summary.disabled,
        reauthRequired: summary.reauthRequired,
        failed: summary.failed,
        stickySessions: providerSessions.length,
        responses: providerResponses.length,
        latestAt: providerLogs[0]?.createdAt,
      };
    }),
  };
}

export function formatPoolBanner(status: PoolStatus): string[] {
  if (status.total === 0) {
    return [
      "Pool: no accounts loaded — run `kyoli login codex`, `kyoli login claude`, or `kyoli accounts import opencode`.",
    ];
  }

  const mode = status.total === 1
    ? "single-account"
    : `${status.strategy}, sticky-ready`;
  const lines = [
    `Pool: ${status.total} account${status.total === 1 ? "" : "s"} loaded — ${mode}; ${formatPoolCounts(status)}.`,
  ];

  for (const provider of status.providers) {
    lines.push(`  ${provider.provider}: ${formatPoolCounts(provider)}`);
  }

  if (status.total === 1) {
    lines.push("  Add another account to enable failover and load balancing.");
  }

  return lines;
}

export function formatPoolDoctorDetail(status: PoolStatus): string {
  if (status.total === 0) {
    return "No accounts loaded. Run `kyoli login codex`, `kyoli login claude`, or `kyoli accounts import opencode`.";
  }
  return `${status.total} total; ${formatPoolCounts(status)}; strategy=${status.strategy}; sticky_sessions=${status.stickySessions}; responses=${status.responses}`;
}

function formatPoolCounts(
  status: Pick<PoolStatus, "ready" | "rateLimited" | "authCooldown" | "disabled" | "reauthRequired" | "failed">,
): string {
  return [
    `ready=${status.ready}`,
    `rate_limited=${status.rateLimited}`,
    `auth_cooldown=${status.authCooldown}`,
    `disabled=${status.disabled}`,
    `reauth_required=${status.reauthRequired}`,
    `failed=${status.failed}`,
  ].join(" ");
}

function sum<K extends keyof ReturnType<typeof summarizeAccountStatus>[number]>(
  summaries: ReturnType<typeof summarizeAccountStatus>,
  key: K,
): number {
  return summaries.reduce((total, summary) => total + Number(summary[key] ?? 0), 0);
}
