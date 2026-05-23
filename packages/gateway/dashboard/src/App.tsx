import {
  AlertTriangle,
  ArrowUpRight,
  CircleDashed,
  KeyRound,
  PauseCircle,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Trash2,
  X,
} from "lucide-react";
import { ClaudeAI, OpenAI } from "developer-icons";
import { AnimatePresence, motion } from "motion/react";
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

type ProviderId = "codex" | "claude-code";
type SectionId = "overview" | "accounts" | "logs" | "sessions";
type ProviderFilter = "all" | ProviderId;
type AccountStateFilter = "all" | "ready" | "blocked" | "rate_limited" | "quota" | "auth" | "disabled";
type LogStatusFilter = "all" | "success" | "failed" | "retry";
type LogTimeframe = "all" | "1h" | "24h" | "7d";

interface HealthResponse {
  ok?: boolean;
  service?: string;
  mode?: string;
  port?: number;
}

interface AccountStatusSummary {
  provider: ProviderId;
  total: number;
  ready: number;
  rate_limited: number;
  quota_exceeded: number;
  auth_cooldown: number;
  disabled: number;
  reauth_required: number;
  failed: number;
  next_reset_at?: string;
  next_auth_retry_at?: string;
}

interface AccountRecord {
  id: string;
  provider: ProviderId;
  kind: string;
  name: string;
  enabled: boolean;
  credentialKeys?: string[];
  metadata?: Record<string, unknown>;
  failureCount: number;
  lastUsedAt?: string;
  lastErrorAt?: string;
  rateLimitResetAt?: string;
  rateLimitBlockedAt?: string;
  rateLimitCooldownUntil?: string;
  authCooldownUntil?: string;
  consecutiveAuthFailures?: number;
  lastFailureClass?: string;
  lastFailureCode?: string;
  lastFailureMessage?: string;
  reauthRequiredReason?: string;
  createdAt: string;
  updatedAt: string;
}

interface RequestLogEvent {
  id: number;
  requestId: string;
  provider: ProviderId;
  route?: string;
  model?: string;
  sessionKey: string;
  accountId?: string;
  eventType: string;
  attempt?: number;
  status?: number;
  retryable?: boolean;
  message?: string;
  createdAt: string;
}

interface RequestLogGroup {
  requestId: string;
  provider: ProviderId;
  route?: string;
  model?: string;
  sessionKey: string;
  accountIds: string[];
  startedAt: string;
  completedAt: string;
  finalStatus?: number;
  retryCount: number;
  events: RequestLogEvent[];
}

interface StickySession {
  key: string;
  provider: ProviderId;
  kind: string;
  sessionKey: string;
  accountId: string;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string | null;
  isStale?: boolean;
  oldRoutePin?: boolean;
}

interface DashboardData {
  health?: HealthResponse;
  status: AccountStatusSummary[];
  accounts: AccountRecord[];
  logs: RequestLogGroup[];
  sessions: StickySession[];
}

interface StickySessionsResponse {
  data: StickySession[];
  stalePromptCacheCount?: number;
}

type Command =
  | {
    id: string;
    label: string;
    meta: string;
    keywords: string;
    icon: "nav" | "filter" | "pause" | "reactivate" | "reset" | "delete";
    dangerous?: boolean;
    run(): void | Promise<void>;
  };

const TOKEN_STORAGE_KEY = "kyoli.dashboard.adminToken";
const POLL_INTERVAL_MS = 5_000;
const DEFAULT_LOG_ROWS = 50;
const DEFAULT_SESSION_ROWS = 40;
const QUOTA_LOW_PERCENT = 20;
const QUOTA_STALE_MS = 15 * 60_000;
const QUOTA_RESET_SOON_MS = 60 * 60_000;
const sections: Array<{ id: SectionId; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "accounts", label: "Accounts" },
  { id: "logs", label: "Request Logs" },
  { id: "sessions", label: "Sticky Sessions" },
];

const emptyData: DashboardData = {
  status: [],
  accounts: [],
  logs: [],
  sessions: [],
};

interface MonitorStats {
  accounts: number;
  ready: number;
  blocked: number;
  requests: number;
  failures: number;
  successRate: number;
}

interface TrafficInsights {
  total: number;
  failures: number;
  retried: number;
  successRate: number;
  retryRate: number;
  p50Ms?: number;
  p95Ms?: number;
  avgMs?: number;
  buckets: UsageBucket[];
  models: BreakdownItem[];
  routes: BreakdownItem[];
  accounts: BreakdownItem[];
  sessions: BreakdownItem[];
}

interface UsageBucket {
  label: string;
  total: number;
  failed: number;
  retried: number;
}

interface BreakdownItem {
  id: string;
  label: string;
  value: number;
  failed: number;
  meta: string;
}

interface AccountQuotaSnapshot {
  account: AccountRecord;
  primary?: QuotaWindowSnapshot;
  secondary?: QuotaWindowSnapshot;
  credits?: string;
  cachedAt?: string;
}

interface AccountQuotaEntry {
  account: AccountRecord;
  snapshot?: AccountQuotaSnapshot;
}

interface AccountProviderGroup {
  provider: ProviderId;
  accounts: AccountRecord[];
  summary?: AccountStatusSummary;
  ready: number;
  blocked: number;
}

interface QuotaWindowSnapshot {
  key: "primary" | "secondary";
  label: string;
  usedPercent?: number;
  remainingPercent?: number;
  resetAt?: string;
}

export function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? "");
  const [tokenDraft, setTokenDraft] = useState(token);
  const [needsToken, setNeedsToken] = useState(false);
  const [data, setData] = useState<DashboardData>(emptyData);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [lastRefreshAt, setLastRefreshAt] = useState<string | undefined>();
  const [providerFilter, setProviderFilter] = useState<ProviderFilter>("all");
  const [accountQuery, setAccountQuery] = useState("");
  const [accountStateFilter, setAccountStateFilter] = useState<AccountStateFilter>("all");
  const [logQuery, setLogQuery] = useState("");
  const [logStatusFilter, setLogStatusFilter] = useState<LogStatusFilter>("all");
  const [logTimeframe, setLogTimeframe] = useState<LogTimeframe>("all");
  const [showAllLogs, setShowAllLogs] = useState(false);
  const [sessionQuery, setSessionQuery] = useState("");
  const [showAllSessions, setShowAllSessions] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>("overview");
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [selectedCommandIndex, setSelectedCommandIndex] = useState(0);

  const commandInputRef = useRef<HTMLInputElement>(null);

  const requestJson = useCallback(async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
    const headers = new Headers(init.headers);
    if (!headers.has("accept")) headers.set("accept", "application/json");
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);

    const response = await fetch(path, {
      ...init,
      headers,
    });

    if (response.status === 401) {
      setNeedsToken(true);
      throw new UnauthorizedError();
    }
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new Error(readApiError(body) ?? `${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }, [token]);

  const refresh = useCallback(async (mode: "initial" | "manual" | "poll" = "manual") => {
    if (mode === "initial") setLoading(true);
    else setRefreshing(true);
    setError(undefined);

    try {
      const [health, status, accounts, logs, sessions] = await Promise.all([
        requestJson<HealthResponse>("/health"),
        requestJson<{ data: AccountStatusSummary[] }>("/admin/accounts/status"),
        requestJson<{ data: AccountRecord[] }>("/admin/accounts"),
        requestJson<{ data: RequestLogGroup[] }>("/admin/request-logs?grouped=true&limit=1000"),
        requestJson<StickySessionsResponse>("/admin/sticky-sessions"),
      ]);

      setData({
        health,
        status: status.data ?? [],
        accounts: accounts.data ?? [],
        logs: logs.data ?? [],
        sessions: sessions.data ?? [],
      });
      setNeedsToken(false);
      setLastRefreshAt(new Date().toISOString());
    } catch (caught) {
      if (caught instanceof UnauthorizedError) {
        setError(undefined);
        return;
      }
      setError(caught instanceof Error ? caught.message : "Dashboard refresh failed.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [requestJson]);

  useEffect(() => {
    void refresh("initial");
  }, [refresh]);

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") void refresh("poll");
    };
    const interval = window.setInterval(tick, POLL_INTERVAL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
      }
      if (event.key === "Escape") {
        setCommandOpen(false);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (!commandOpen) return;
    setCommandQuery("");
    setSelectedCommandIndex(0);
    window.setTimeout(() => commandInputRef.current?.focus(), 0);
  }, [commandOpen]);

  const filteredAccounts = useMemo(
    () => data.accounts.filter((account) => providerFilter === "all" || account.provider === providerFilter),
    [data.accounts, providerFilter],
  );
  const visibleAccounts = useMemo(() => {
    const query = accountQuery.trim().toLowerCase();
    return sortAccountsForOperations(filteredAccounts.filter((account) => {
      if (!matchesAccountStateFilter(account, accountStateFilter)) return false;
      if (!query) return true;
      return [
        account.name,
        account.id,
        account.provider,
        account.kind,
        readPlan(account),
        readString(account.metadata?.email),
        account.lastFailureCode,
        account.lastFailureMessage,
      ].filter(Boolean).join(" ").toLowerCase().includes(query);
    }));
  }, [accountQuery, accountStateFilter, filteredAccounts]);
  const logsWithSessionModels = useMemo(() => inheritRequestLogSessionModels(data.logs), [data.logs]);
  const filteredLogs = useMemo(
    () => logsWithSessionModels.filter((log) => providerFilter === "all" || log.provider === providerFilter),
    [logsWithSessionModels, providerFilter],
  );
  const visibleLogs = useMemo(() => {
    const query = logQuery.trim().toLowerCase();
    return filteredLogs.filter((log) => {
      if (!matchesLogStatusFilter(log, logStatusFilter)) return false;
      if (!matchesLogTimeframe(log, logTimeframe)) return false;
      if (!query) return true;
      return [
        requestRouteLabel(log),
        log.requestId,
        log.model,
        log.sessionKey,
        log.provider,
        ...log.accountIds,
        ...log.events.map((event) => `${event.eventType} ${event.message ?? ""} ${event.status ?? ""}`),
      ].filter(Boolean).join(" ").toLowerCase().includes(query);
    });
  }, [filteredLogs, logQuery, logStatusFilter, logTimeframe]);
  const filteredSessions = useMemo(
    () => data.sessions.filter((session) => providerFilter === "all" || session.provider === providerFilter),
    [data.sessions, providerFilter],
  );
  const accountById = useMemo(() => new Map(data.accounts.map((account) => [account.id, account])), [data.accounts]);
  const visibleSessions = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase();
    if (!query) return filteredSessions;
    return filteredSessions.filter((session) => [
      session.key,
      session.provider,
      session.kind,
      session.sessionKey,
      session.accountId,
      accountById.get(session.accountId)?.name,
    ].filter(Boolean).join(" ").toLowerCase().includes(query));
  }, [accountById, filteredSessions, sessionQuery]);
  const displayedLogs = useMemo(
    () => showAllLogs ? visibleLogs : visibleLogs.slice(0, DEFAULT_LOG_ROWS),
    [showAllLogs, visibleLogs],
  );
  const displayedSessions = useMemo(
    () => showAllSessions ? visibleSessions : visibleSessions.slice(0, DEFAULT_SESSION_ROWS),
    [showAllSessions, visibleSessions],
  );
  const monitorStats = useMemo<MonitorStats>(() => {
    const failures = filteredLogs.filter((log) => typeof log.finalStatus === "number" && log.finalStatus >= 400).length;
    const requests = filteredLogs.length;
    const ready = filteredAccounts.filter((account) => readAccountState(account).tone === "good").length;
    return {
      accounts: filteredAccounts.length,
      ready,
      blocked: Math.max(filteredAccounts.length - ready, 0),
      requests,
      failures,
      successRate: requests === 0 ? 100 : Math.round(((requests - failures) / requests) * 100),
    };
  }, [filteredAccounts, filteredLogs]);
  const trafficInsights = useMemo(
    () => buildTrafficInsights(filteredLogs, filteredAccounts, filteredSessions, accountById),
    [accountById, filteredAccounts, filteredLogs, filteredSessions],
  );
  const quotaEntries = useMemo(
    () => buildAccountQuotaEntries(filteredAccounts),
    [filteredAccounts],
  );
  const performAccountAction = useCallback(async (
    account: AccountRecord,
    action: "pause" | "reactivate" | "reset",
  ) => {
    const verb = action === "pause" ? "pause" : action === "reactivate" ? "reactivate" : "reset";
    if (!window.confirm(`${verb} ${account.name}?`)) return;
    await requestJson(`/admin/accounts/${encodeURIComponent(account.id)}/${action}`, {
      method: "POST",
      body: action === "reset" ? JSON.stringify({ enable: true }) : undefined,
    });
    await refresh("manual");
  }, [refresh, requestJson]);

  const deleteStickySession = useCallback(async (session: StickySession) => {
    if (!window.confirm(`release route pin ${session.key}?`)) return;
    await requestJson("/admin/sticky-sessions/delete", {
      method: "POST",
      body: JSON.stringify({ key: session.key }),
    });
    await refresh("manual");
  }, [refresh, requestJson]);

  const purgeOldStickySessions = useCallback(async () => {
    if (!window.confirm("release route pins that have not been used for 24 hours?")) return;
    await requestJson("/admin/sticky-sessions/purge", {
      method: "POST",
      body: JSON.stringify({ maxAgeSeconds: 24 * 60 * 60 }),
    });
    await refresh("manual");
  }, [refresh, requestJson]);

  const goToSection = useCallback((section: SectionId) => {
    setActiveSection(section);
    document.getElementById(section)?.scrollIntoView({ block: "start" });
  }, []);

  const commands = useMemo<Command[]>(() => {
    const nav = sections.map((section) => ({
      id: `nav:${section.id}`,
      label: section.label,
      meta: "Navigate",
      keywords: section.label,
      icon: "nav" as const,
      run: () => goToSection(section.id),
    }));
    const filters: Command[] = [
      {
        id: "filter:all",
        label: "All providers",
        meta: "Filter",
        keywords: "all providers filter",
        icon: "filter",
        run: () => setProviderFilter("all"),
      },
      {
        id: "filter:codex",
        label: "Codex only",
        meta: "Filter",
        keywords: "codex openai filter",
        icon: "filter",
        run: () => setProviderFilter("codex"),
      },
      {
        id: "filter:claude",
        label: "Claude Code only",
        meta: "Filter",
        keywords: "claude anthropic filter",
        icon: "filter",
        run: () => setProviderFilter("claude-code"),
      },
    ];
    const accountActions = data.accounts.flatMap((account) => [
      {
        id: `account:${account.id}:pause`,
        label: `Pause ${account.name}`,
        meta: account.provider,
        keywords: `${account.name} ${account.id} ${account.provider} pause disable`,
        icon: "pause" as const,
        dangerous: true,
        run: () => performAccountAction(account, "pause"),
      },
      {
        id: `account:${account.id}:reactivate`,
        label: `Reactivate ${account.name}`,
        meta: account.provider,
        keywords: `${account.name} ${account.id} ${account.provider} reactivate enable`,
        icon: "reactivate" as const,
        run: () => performAccountAction(account, "reactivate"),
      },
      {
        id: `account:${account.id}:reset`,
        label: `Reset ${account.name}`,
        meta: account.provider,
        keywords: `${account.name} ${account.id} ${account.provider} reset clear`,
        icon: "reset" as const,
        dangerous: true,
        run: () => performAccountAction(account, "reset"),
      },
    ]);
  const sessionActions = data.sessions.slice(0, 30).map((session) => ({
    id: `session:${session.key}:delete`,
    label: `Release ${shorten(session.key, 28)}`,
    meta: `${providerLabel(session.provider)} ${sessionKindLabel(session.kind)}`,
    keywords: `${session.key} ${session.sessionKey} ${session.accountId} release delete sticky session pin`,
    icon: "delete" as const,
    dangerous: true,
    run: () => deleteStickySession(session),
  }));
    return [...nav, ...filters, ...accountActions, ...sessionActions];
  }, [data.accounts, data.sessions, deleteStickySession, goToSection, performAccountAction]);

  const visibleCommands = useMemo(() => {
    const query = commandQuery.trim().toLowerCase();
    if (!query) return commands.slice(0, 18);
    return commands
      .filter((command) => `${command.label} ${command.meta} ${command.keywords}`.toLowerCase().includes(query))
      .slice(0, 18);
  }, [commandQuery, commands]);

  useEffect(() => {
    setSelectedCommandIndex(0);
  }, [commandQuery]);

  const runCommand = useCallback(async (command: Command | undefined) => {
    if (!command) return;
    setCommandOpen(false);
    await command.run();
  }, []);

  const handleCommandKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedCommandIndex((current) => Math.min(current + 1, visibleCommands.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedCommandIndex((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      void runCommand(visibleCommands[selectedCommandIndex]);
    }
  };

  const submitToken = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextToken = tokenDraft.trim();
    setToken(nextToken);
    if (nextToken) sessionStorage.setItem(TOKEN_STORAGE_KEY, nextToken);
    else sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    setNeedsToken(false);
  };

  return (
    <div className="min-h-dvh bg-[#f7f8f3] text-[#17211b]">
      <header className="sticky top-0 z-30 border-b border-black/10 bg-[#f7f8f3]/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-lg bg-[#17211b] text-white shadow-[0_10px_28px_rgba(23,33,27,0.18)]">
                <Server size={20} aria-hidden="true" />
              </div>
              <div>
                <h1 className="balanced-text text-xl font-semibold tracking-normal">Kyoli Gateway</h1>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-[#59645d]">
                  <StatusPill tone={data.health?.ok ? "good" : loading ? "neutral" : "bad"}>
                    {data.health?.service ?? "kyoli-gam"}
                  </StatusPill>
                  <span className="numeric">port {data.health?.port ?? "-"}</span>
                  <span>{refreshing ? "refreshing" : lastRefreshAt ? `refreshed ${relativeTime(lastRefreshAt)}` : "loading"}</span>
                </div>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <button
                type="button"
                className="focus-ring flex min-h-11 min-w-0 items-center gap-2 rounded-lg bg-white px-3 text-left text-sm text-[#59645d] shadow-[0_1px_2px_rgba(23,33,27,0.08),0_8px_26px_rgba(23,33,27,0.08)] transition-transform duration-150 active:scale-[0.96] sm:w-80"
                onClick={() => setCommandOpen(true)}
              >
                <Search size={16} aria-hidden="true" />
                <span className="flex-1 truncate">Search commands, accounts, sessions</span>
                <kbd className="hidden rounded-md bg-[#eef1e7] px-2 py-1 text-xs font-medium text-[#364139] sm:inline">⌘K</kbd>
              </button>
              <button
                type="button"
                className="focus-ring inline-flex min-h-11 items-center justify-center gap-2 rounded-lg bg-[#116a61] px-4 text-sm font-medium text-white shadow-[0_10px_24px_rgba(17,106,97,0.2)] transition-transform duration-150 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => void refresh("manual")}
                disabled={refreshing}
              >
                <RefreshCw size={16} className={refreshing ? "animate-spin" : ""} aria-hidden="true" />
                Refresh
              </button>
            </div>
          </div>
          <TokenBanner
            needsToken={needsToken}
            tokenDraft={tokenDraft}
            setTokenDraft={setTokenDraft}
            onSubmit={submitToken}
            onClear={() => {
              setToken("");
              setTokenDraft("");
              sessionStorage.removeItem(TOKEN_STORAGE_KEY);
              setNeedsToken(false);
            }}
          />
          {error ? (
            <div className="flex items-start gap-2 rounded-lg bg-[#fff1e6] px-3 py-2 text-sm text-[#7a3418] shadow-[inset_0_0_0_1px_rgba(194,65,12,0.16)]">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </div>
          ) : null}
        </div>
      </header>

      <main className="mx-auto grid min-w-0 max-w-7xl gap-6 px-4 py-6 pb-20 sm:px-6 lg:px-8">
        <section className="flex min-w-0 flex-col gap-3 md:flex-row md:items-center md:justify-between" aria-label="Dashboard navigation">
          <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:max-w-full sm:overflow-x-auto sm:pb-1 md:w-auto">
            {sections.map((section) => (
              <button
                key={section.id}
                type="button"
                className={`focus-ring min-h-10 rounded-lg px-3 text-sm font-medium transition-colors duration-150 sm:shrink-0 ${
                  activeSection === section.id
                    ? "bg-[#17211b] text-white"
                    : "bg-white text-[#465149] shadow-[0_1px_2px_rgba(23,33,27,0.08)] hover:bg-[#eef1e7]"
                }`}
                onClick={() => goToSection(section.id)}
              >
                {section.label}
              </button>
            ))}
          </div>
          <ProviderFilterControl value={providerFilter} onChange={setProviderFilter} />
        </section>

        <OperationsOverview
          stats={monitorStats}
          status={data.status}
          accounts={filteredAccounts}
          logs={filteredLogs}
          sessions={filteredSessions}
          onAccountFilter={setAccountStateFilter}
          onLogStatusFilter={setLogStatusFilter}
          onNavigate={goToSection}
        />

        <section id="accounts" className="min-w-0 scroll-mt-36">
          <SectionHeader
            eyebrow="Accounts"
            title="Account pool health"
            detail={`${visibleAccounts.length} of ${filteredAccounts.length} account${filteredAccounts.length === 1 ? "" : "s"} visible`}
          />
          <AccountPoolSummary accounts={filteredAccounts} quotaEntries={quotaEntries} summaries={data.status} />
          <AccountFilters
            query={accountQuery}
            state={accountStateFilter}
            onQueryChange={setAccountQuery}
            onStateChange={setAccountStateFilter}
            onReset={() => {
              setAccountQuery("");
              setAccountStateFilter("all");
            }}
          />
          <AccountQuotaPanel entries={quotaEntries} summaries={data.status} />
          <div className="mt-4">
            <div className="text-sm font-semibold text-[#17211b]">Account controls</div>
            <div className="mt-1 text-xs text-[#59645d]">Pause, reactivate, or reset account state after triage.</div>
          </div>
          <div className="mt-3 min-w-0 overflow-hidden rounded-lg bg-white shadow-[0_1px_2px_rgba(23,33,27,0.08),0_12px_36px_rgba(23,33,27,0.08)]">
            <AccountsTable accounts={visibleAccounts} status={data.status} onAction={performAccountAction} />
          </div>
        </section>

        <section id="logs" className="min-w-0 scroll-mt-36">
          <SectionHeader
            eyebrow="Request Logs"
            title="Recent request flow"
            detail={`${visibleLogs.length} of ${filteredLogs.length} grouped request${filteredLogs.length === 1 ? "" : "s"} · ${trafficInsights.successRate}% success`}
          />
          <RequestTrafficPanel insights={trafficInsights} />
          <RequestLogFilters
            query={logQuery}
            status={logStatusFilter}
            timeframe={logTimeframe}
            onQueryChange={setLogQuery}
            onStatusChange={setLogStatusFilter}
            onTimeframeChange={setLogTimeframe}
            onReset={() => {
              setLogQuery("");
              setLogStatusFilter("all");
              setLogTimeframe("all");
              setShowAllLogs(false);
            }}
          />
          <RequestLogList logs={displayedLogs} accountById={accountById} />
          <ShowMoreRow
            visible={displayedLogs.length}
            total={visibleLogs.length}
            limit={DEFAULT_LOG_ROWS}
            expanded={showAllLogs}
            onToggle={() => setShowAllLogs((value) => !value)}
          />
        </section>

        <section id="sessions" className="min-w-0 scroll-mt-36 pb-10">
          <SectionHeader
            eyebrow="Sticky Sessions"
            title="Session route pins"
            detail={`${visibleSessions.length} of ${filteredSessions.length} route pin${filteredSessions.length === 1 ? "" : "s"} keeping follow-up requests on the same account`}
          />
          <StickySessionSummary sessions={visibleSessions} accountById={accountById} />
          <StickySessionFilters
            query={sessionQuery}
            onQueryChange={setSessionQuery}
            oldCount={visibleSessions.filter(isOldRoutePin).length}
            onPurgeOld={purgeOldStickySessions}
            onReset={() => {
              setSessionQuery("");
              setShowAllSessions(false);
            }}
          />
          <StickySessionList sessions={displayedSessions} accountById={accountById} onDelete={deleteStickySession} />
          <ShowMoreRow
            visible={displayedSessions.length}
            total={visibleSessions.length}
            limit={DEFAULT_SESSION_ROWS}
            expanded={showAllSessions}
            onToggle={() => setShowAllSessions((value) => !value)}
          />
        </section>
      </main>

      <CommandPalette
        open={commandOpen}
        query={commandQuery}
        setQuery={setCommandQuery}
        commands={visibleCommands}
        selectedIndex={selectedCommandIndex}
        inputRef={commandInputRef}
        onClose={() => setCommandOpen(false)}
        onKeyDown={handleCommandKeyDown}
        onRun={runCommand}
      />
    </div>
  );
}

class UnauthorizedError extends Error {}

function OperationsOverview(props: {
  stats: MonitorStats;
  status: AccountStatusSummary[];
  accounts: AccountRecord[];
  logs: RequestLogGroup[];
  sessions: StickySession[];
  onAccountFilter(value: AccountStateFilter): void;
  onLogStatusFilter(value: LogStatusFilter): void;
  onNavigate(section: SectionId): void;
}) {
  const blockedAccounts = props.accounts
    .filter((account) => readAccountState(account).tone !== "good")
    .sort((a, b) => resetTimestamp(a) - resetTimestamp(b))
    .slice(0, 4);
  const failedLogs = props.logs
    .filter((log) => typeof log.finalStatus === "number" && log.finalStatus >= 400)
    .slice(0, 4);
  const nextReset = props.status
    .map((summary) => summary.next_reset_at ?? summary.next_auth_retry_at)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => Date.parse(a) - Date.parse(b))[0];

  return (
    <section id="overview" className="grid min-w-0 scroll-mt-36 gap-3 lg:grid-cols-[minmax(0,1.25fr)_minmax(340px,0.75fr)]">
      <div className="min-w-0 rounded-lg bg-white p-4 shadow-[0_1px_2px_rgba(23,33,27,0.08),0_12px_36px_rgba(23,33,27,0.08)]">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[#116a61]">Overview</div>
            <h2 className="balanced-text mt-1 text-xl font-semibold">What needs attention</h2>
          </div>
          <div className="text-sm text-[#59645d]">
            {nextReset ? `Next reset ${relativeTime(nextReset)}` : "No pending reset window"}
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <button type="button" className="focus-ring rounded-lg bg-[#eef1e7] p-3 text-left transition-transform duration-150 active:scale-[0.96]" onClick={() => props.onNavigate("accounts")}>
            <div className="text-xs text-[#59645d]">Capacity</div>
            <div className="numeric mt-1 text-2xl font-semibold">{props.stats.ready}/{props.stats.accounts}</div>
            <div className="mt-1 text-xs text-[#59645d]">ready accounts</div>
          </button>
          <button type="button" className="focus-ring rounded-lg bg-[#fff8e6] p-3 text-left transition-transform duration-150 active:scale-[0.96]" onClick={() => {
            props.onAccountFilter("blocked");
            props.onNavigate("accounts");
          }}>
            <div className="text-xs text-[#7a4d00]">Blocked</div>
            <div className="numeric mt-1 text-2xl font-semibold text-[#7a4d00]">{props.stats.blocked}</div>
            <div className="mt-1 text-xs text-[#7a4d00]/75">rate/quota/auth</div>
          </button>
          <button type="button" className="focus-ring rounded-lg bg-[#eef1e7] p-3 text-left transition-transform duration-150 active:scale-[0.96]" onClick={() => props.onNavigate("sessions")}>
            <div className="text-xs text-[#59645d]">Sticky sessions</div>
            <div className="numeric mt-1 text-2xl font-semibold">{props.sessions.length}</div>
            <div className="mt-1 text-xs text-[#59645d]">active bindings</div>
          </button>
          <button type="button" className="focus-ring rounded-lg bg-[#ffe4df] p-3 text-left transition-transform duration-150 active:scale-[0.96]" onClick={() => {
            props.onLogStatusFilter("failed");
            props.onNavigate("logs");
          }}>
            <div className="text-xs text-[#b42318]">Recent failures</div>
            <div className="numeric mt-1 text-2xl font-semibold text-[#b42318]">{props.stats.failures}</div>
            <div className="mt-1 text-xs text-[#b42318]/75">{props.stats.successRate}% success</div>
          </button>
        </div>

        <div className="mt-4 grid items-start gap-3 lg:grid-cols-2">
          <AttentionList
            title="Blocked accounts"
            empty="No blocked accounts in this provider scope"
            items={blockedAccounts.map((account) => ({
              id: account.id,
              provider: account.provider,
              label: accountDisplayName(account, { compact: true }),
              meta: joinMeta([readAccountState(account).label, readPlan(account)]),
              detail: account.rateLimitResetAt ? `reset ${relativeTime(account.rateLimitResetAt)}` : account.lastFailureMessage ?? "needs review",
            }))}
            onClick={() => props.onNavigate("accounts")}
          />
          <AttentionList
            title="Failed requests"
            empty="No failed requests in the current log window"
            items={failedLogs.map((log) => ({
              id: log.requestId,
              provider: log.provider,
              label: requestRouteLabel(log),
              meta: joinMeta([displayModelName(log.model), log.retryCount > 0 ? `${log.retryCount} retries` : undefined]),
              detail: log.events.find((event) => event.message)?.message ?? `${log.finalStatus ?? "error"} · ${relativeTime(log.startedAt)}`,
            }))}
            onClick={() => props.onNavigate("logs")}
          />
        </div>
      </div>

      <div className="grid min-w-0 content-start gap-3">
        {props.status.length > 0 ? props.status.map((summary) => (
          <ProviderOpsCard key={summary.provider} summary={summary} />
        )) : <EmptyPanel label="No provider capacity data yet" />}
      </div>
    </section>
  );
}

function ProviderOpsCard({ summary }: { summary: AccountStatusSummary }) {
  const blocked = summary.rate_limited + summary.quota_exceeded + summary.auth_cooldown + summary.disabled + summary.reauth_required;
  const readyPercent = summary.total > 0 ? Math.round((summary.ready / summary.total) * 100) : 0;
  return (
    <article className="min-w-0 rounded-lg bg-[#17211b] p-4 text-white shadow-[0_12px_36px_rgba(23,33,27,0.14)]">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <ProviderMark provider={summary.provider} tone="dark" />
          <div className="numeric mt-1 text-2xl font-semibold">{summary.ready}/{summary.total}</div>
        </div>
        <StatusPill tone={blocked > 0 ? "warn" : "good"}>{blocked > 0 ? `${blocked} blocked` : "ready"}</StatusPill>
      </div>
      <div className="mt-4 h-2 overflow-hidden rounded-full bg-white/10">
        <div className="h-full rounded-full bg-[#35c46f]" style={{ width: `${readyPercent}%` }} />
      </div>
      <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
        <MiniStat label="Rate" value={summary.rate_limited} />
        <MiniStat label="Quota" value={summary.quota_exceeded} />
        <MiniStat label="Auth" value={summary.auth_cooldown + summary.reauth_required} />
      </div>
    </article>
  );
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md bg-white/10 p-2">
      <div className="numeric font-semibold">{value}</div>
      <div className="text-white/55">{label}</div>
    </div>
  );
}

function AttentionList(props: {
  title: string;
  empty: string;
  items: Array<{ id: string; provider?: ProviderId; label: string; meta?: string; detail: string }>;
  onClick(): void;
}) {
  return (
    <button type="button" className="focus-ring min-w-0 rounded-lg bg-[#f7f8f3] p-3 text-left transition-transform duration-150 active:scale-[0.96]" onClick={props.onClick}>
      <div className="text-sm font-semibold">{props.title}</div>
      <div className="mt-2 grid gap-2">
        {props.items.length === 0 ? (
          <div className="text-sm text-[#59645d]">{props.empty}</div>
        ) : props.items.map((item) => (
          <div key={item.id} className="min-w-0 rounded-md bg-white p-2 shadow-[0_1px_2px_rgba(23,33,27,0.08)]">
            <div className="flex min-w-0 items-center gap-2">
              {item.provider ? <ProviderIcon provider={item.provider} size={16} /> : null}
              <div className="truncate text-sm font-medium">{item.label}</div>
            </div>
            {item.meta ? <div className="mt-0.5 truncate text-xs text-[#59645d]">{item.meta}</div> : null}
            <div className="mt-0.5 truncate text-xs text-[#7a4d00]">{item.detail}</div>
          </div>
        ))}
      </div>
    </button>
  );
}

function AccountFilters(props: {
  query: string;
  state: AccountStateFilter;
  onQueryChange(value: string): void;
  onStateChange(value: AccountStateFilter): void;
  onReset(): void;
}) {
  return (
    <div className="mt-3 grid gap-2 rounded-lg bg-white p-3 shadow-[0_1px_2px_rgba(23,33,27,0.08)] lg:grid-cols-[minmax(220px,1fr)_auto_auto] lg:items-center">
      <SearchInput value={props.query} onChange={props.onQueryChange} placeholder="Search account, plan, id, failure..." />
      <SegmentedControl
        value={props.state}
        options={[
          ["all", "All"],
          ["ready", "Ready"],
          ["blocked", "Blocked"],
          ["rate_limited", "Rate"],
          ["quota", "Quota"],
          ["auth", "Auth"],
          ["disabled", "Disabled"],
        ]}
        onChange={(value) => props.onStateChange(value as AccountStateFilter)}
      />
      <button type="button" className="focus-ring min-h-10 rounded-lg bg-[#eef1e7] px-3 text-sm font-medium text-[#465149] transition-transform duration-150 active:scale-[0.96]" onClick={props.onReset}>
        Clear filters
      </button>
    </div>
  );
}

function RequestLogFilters(props: {
  query: string;
  status: LogStatusFilter;
  timeframe: LogTimeframe;
  onQueryChange(value: string): void;
  onStatusChange(value: LogStatusFilter): void;
  onTimeframeChange(value: LogTimeframe): void;
  onReset(): void;
}) {
  return (
    <div className="mt-3 grid gap-2 rounded-lg bg-white p-3 shadow-[0_1px_2px_rgba(23,33,27,0.08)] xl:grid-cols-[minmax(260px,1fr)_auto_auto_auto] xl:items-center">
      <SearchInput value={props.query} onChange={props.onQueryChange} placeholder="Search route, request id, model, session, account..." />
      <SegmentedControl
        value={props.status}
        options={[
          ["all", "All"],
          ["success", "Success"],
          ["failed", "Failed"],
          ["retry", "Retried"],
        ]}
        onChange={(value) => props.onStatusChange(value as LogStatusFilter)}
      />
      <SegmentedControl
        value={props.timeframe}
        options={[
          ["1h", "1H"],
          ["24h", "24H"],
          ["7d", "7D"],
          ["all", "All"],
        ]}
        onChange={(value) => props.onTimeframeChange(value as LogTimeframe)}
      />
      <button type="button" className="focus-ring min-h-10 rounded-lg bg-[#eef1e7] px-3 text-sm font-medium text-[#465149] transition-transform duration-150 active:scale-[0.96]" onClick={props.onReset}>
        Reset
      </button>
    </div>
  );
}

function StickySessionFilters(props: {
  query: string;
  onQueryChange(value: string): void;
  oldCount: number;
  onPurgeOld(): Promise<void>;
  onReset(): void;
}) {
  return (
    <div className="mt-3 grid gap-2 rounded-lg bg-white p-3 shadow-[0_1px_2px_rgba(23,33,27,0.08)] lg:grid-cols-[minmax(220px,1fr)_auto_auto] lg:items-center">
      <SearchInput value={props.query} onChange={props.onQueryChange} placeholder="Search session key, pinned account, provider..." />
      <button
        type="button"
        className="focus-ring min-h-10 rounded-lg bg-[#fff8e6] px-3 text-sm font-medium text-[#7a4d00] transition-transform duration-150 disabled:cursor-not-allowed disabled:opacity-45 active:scale-[0.96]"
        onClick={() => void props.onPurgeOld()}
        disabled={props.oldCount === 0}
      >
        Purge old pins
      </button>
      <button type="button" className="focus-ring min-h-10 rounded-lg bg-[#eef1e7] px-3 text-sm font-medium text-[#465149] transition-transform duration-150 active:scale-[0.96]" onClick={props.onReset}>
        Reset
      </button>
    </div>
  );
}

function ShowMoreRow(props: {
  visible: number;
  total: number;
  limit: number;
  expanded: boolean;
  onToggle(): void;
}) {
  if (props.total <= props.limit) return null;
  return (
    <div className="mt-3 flex flex-col gap-2 rounded-lg bg-white p-3 text-sm text-[#59645d] shadow-[0_1px_2px_rgba(23,33,27,0.08)] sm:flex-row sm:items-center sm:justify-between">
      <span className="numeric">Showing {props.visible} of {props.total}</span>
      <button
        type="button"
        className="focus-ring min-h-10 rounded-lg bg-[#17211b] px-3 font-medium text-white transition-transform duration-150 active:scale-[0.96]"
        onClick={props.onToggle}
      >
        {props.expanded ? "Collapse" : "Show all"}
      </button>
    </div>
  );
}

function SearchInput(props: { value: string; onChange(value: string): void; placeholder: string }) {
  return (
    <label className="relative min-w-0">
      <span className="sr-only">{props.placeholder}</span>
      <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#8a948d]" aria-hidden="true" />
      <input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className="focus-ring min-h-10 w-full rounded-lg bg-[#f7f8f3] px-9 text-sm text-[#17211b] shadow-[inset_0_0_0_1px_rgba(23,33,27,0.08)] placeholder:text-[#8a948d]"
        placeholder={props.placeholder}
      />
    </label>
  );
}

function SegmentedControl(props: {
  value: string;
  options: Array<[string, string]>;
  onChange(value: string): void;
}) {
  return (
    <div className="flex max-w-full gap-1 overflow-x-auto rounded-lg bg-[#eef1e7] p-1">
      {props.options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          className={`focus-ring min-h-8 shrink-0 rounded-md px-2.5 text-xs font-semibold transition-colors duration-150 ${
            props.value === value ? "bg-white text-[#116a61] shadow-[0_1px_2px_rgba(23,33,27,0.08)]" : "text-[#59645d] hover:bg-white/60"
          }`}
          onClick={() => props.onChange(value)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function TokenBanner(props: {
  needsToken: boolean;
  tokenDraft: string;
  setTokenDraft(value: string): void;
  onSubmit(event: FormEvent<HTMLFormElement>): void;
  onClear(): void;
}) {
  if (!props.needsToken && !props.tokenDraft) return null;
  return (
    <form
      data-testid={dashboardTestIds.tokenPrompt}
      onSubmit={props.onSubmit}
      className="grid gap-2 rounded-lg bg-[#fff8e6] p-3 text-sm shadow-[inset_0_0_0_1px_rgba(202,138,4,0.2)] md:grid-cols-[auto_1fr_auto_auto] md:items-center"
    >
      <div className="flex items-center gap-2 font-medium text-[#6b4f0f]">
        <KeyRound size={16} aria-hidden="true" />
        Admin token
      </div>
      <input
        className="focus-ring min-h-10 rounded-lg bg-white px-3 text-[#17211b] shadow-[inset_0_0_0_1px_rgba(23,33,27,0.12)]"
        value={props.tokenDraft}
        type="password"
        autoComplete="current-password"
        onChange={(event) => props.setTokenDraft(event.target.value)}
        aria-label="Admin token"
      />
      <button
        type="submit"
        className="focus-ring min-h-10 rounded-lg bg-[#17211b] px-3 font-medium text-white transition-transform duration-150 active:scale-[0.96]"
      >
        Save
      </button>
      <button
        type="button"
        className="focus-ring min-h-10 rounded-lg bg-white px-3 font-medium text-[#465149] transition-transform duration-150 active:scale-[0.96]"
        onClick={props.onClear}
      >
        Clear
      </button>
    </form>
  );
}

function ProviderFilterControl(props: { value: ProviderFilter; onChange(value: ProviderFilter): void }) {
  return (
    <div className="flex shrink-0 rounded-lg bg-white p-1 shadow-[0_1px_2px_rgba(23,33,27,0.08)]">
      {[
        ["all", "All"],
        ["codex", "Codex"],
        ["claude-code", "Claude"],
      ].map(([value, label]) => (
        <button
          key={value}
          type="button"
          className={`focus-ring min-h-9 rounded-md px-3 text-sm font-medium transition-colors duration-150 ${
            props.value === value ? "bg-[#dff3ee] text-[#116a61]" : "text-[#59645d] hover:bg-[#eef1e7]"
          }`}
          onClick={() => props.onChange(value as ProviderFilter)}
        >
          {value === "all" ? label : <ProviderMark provider={value as ProviderId} label="short" />}
        </button>
      ))}
    </div>
  );
}

function ProviderMark(props: {
  provider: ProviderId;
  label?: "full" | "short" | "none";
  tone?: "light" | "dark";
}) {
  const label = props.label ?? "full";
  const text = label === "short" ? providerShortLabel(props.provider) : providerLabel(props.provider);
  const textClass = props.tone === "dark" ? "text-white/70" : "text-[#59645d]";
  return (
    <span className={`inline-flex min-w-0 items-center gap-1.5 text-sm font-medium ${textClass}`}>
      <ProviderIcon provider={props.provider} size={18} />
      {label === "none" ? null : <span className="truncate">{text}</span>}
    </span>
  );
}

function ProviderIcon({ provider, size = 18 }: { provider: ProviderId; size?: number }) {
  const Icon = provider === "claude-code" ? ClaudeAI : OpenAI;
  const tone = provider === "claude-code"
    ? "bg-[#f4efe7] text-[#8a5a2b] shadow-[inset_0_0_0_1px_rgba(138,90,43,0.16)]"
    : "bg-[#e5f4ef] text-[#0b6f54] shadow-[inset_0_0_0_1px_rgba(11,111,84,0.16)]";
  return (
    <span className={`inline-flex size-6 shrink-0 items-center justify-center rounded-md ${tone}`}>
      <Icon size={size} aria-hidden="true" focusable="false" />
    </span>
  );
}

function SectionHeader(props: { eyebrow: string; title: string; detail: string }) {
  return (
    <div>
      <div className="text-xs font-semibold uppercase tracking-[0.08em] text-[#116a61]">{props.eyebrow}</div>
      <div className="mt-1 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <h2 className="balanced-text text-2xl font-semibold tracking-normal text-[#17211b]">{props.title}</h2>
        <p className="pretty-text text-sm text-[#59645d]">{props.detail}</p>
      </div>
    </div>
  );
}

function RequestTrafficPanel({
  insights,
}: {
  insights: TrafficInsights;
}) {
  return (
    <article className="mt-3 min-w-0 rounded-lg bg-[#17211b] p-4 text-white shadow-[0_12px_36px_rgba(23,33,27,0.16)]">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-sm text-white/60">Traffic health</div>
          <div className="numeric mt-1 text-3xl font-semibold">{insights.successRate}%</div>
          <div className="mt-1 text-sm text-white/60">success across recent gateway traffic</div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <InsightMetric label="Requests" value={insights.total} />
          <InsightMetric label="Retried" value={`${insights.retryRate}%`} />
          <InsightMetric label="P50" value={insights.p50Ms == null ? "-" : formatDuration(insights.p50Ms)} />
          <InsightMetric label="P95" value={insights.p95Ms == null ? "-" : formatDuration(insights.p95Ms)} />
        </div>
      </div>
      <UsageGraph buckets={insights.buckets} />
    </article>
  );
}

function AccountPoolSummary({ accounts, quotaEntries, summaries }: { accounts: AccountRecord[]; quotaEntries: AccountQuotaEntry[]; summaries: AccountStatusSummary[] }) {
  const ready = accounts.filter((account) => readAccountState(account).tone === "good").length;
  const blocked = Math.max(accounts.length - ready, 0);
  const low = quotaEntries.filter((entry) => entry.snapshot && isLowQuota(entry.snapshot)).length;
  const missing = quotaEntries.filter((entry) => !entry.snapshot).length;
  const nextReset = nextQuotaReset(quotaEntries, summaries);
  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
      <AccountPoolMetric label="Ready pool" value={`${ready}/${accounts.length}`} detail="eligible accounts" tone={blocked > 0 ? "warn" : "good"} />
      <AccountPoolMetric label="Blocked" value={blocked} detail="rate/quota/auth/disabled" tone={blocked > 0 ? "warn" : "good"} />
      <AccountPoolMetric label="Low quota" value={low} detail="≤20% remaining" tone={low > 0 ? "bad" : "good"} />
      <AccountPoolMetric label="Missing quota" value={missing} detail="no cached snapshot" tone={missing > 0 ? "warn" : "good"} />
      <AccountPoolMetric label="Next reset" value={nextReset ? relativeTime(nextReset) : "unknown"} detail={nextReset ? formatLocalClock(nextReset) : "quota window"} tone={nextReset && isResetSoon(nextReset) ? "warn" : "neutral"} />
    </div>
  );
}

function AccountPoolMetric({ label, value, detail, tone }: { label: string; value: string | number; detail: string; tone: "good" | "warn" | "bad" | "neutral" }) {
  const className = tone === "good"
    ? "bg-[#eef1e7] text-[#17211b]"
    : tone === "warn"
      ? "bg-[#fff8e6] text-[#7a4d00]"
      : tone === "bad"
        ? "bg-[#ffe4df] text-[#b42318]"
        : "bg-white text-[#17211b]";
  return (
    <div className={`rounded-lg p-3 shadow-[0_1px_2px_rgba(23,33,27,0.08)] ${className}`}>
      <div className="text-xs opacity-75">{label}</div>
      <div className="numeric mt-1 text-xl font-semibold">{value}</div>
      <div className="mt-1 text-xs opacity-70">{detail}</div>
    </div>
  );
}

function AccountQuotaPanel({ entries, summaries }: { entries: AccountQuotaEntry[]; summaries: AccountStatusSummary[] }) {
  const tracked = entries.filter((entry) => entry.snapshot).length;
  const low = entries.filter((entry) => entry.snapshot && isLowQuota(entry.snapshot)).length;
  const stale = entries.filter((entry) => entry.snapshot?.cachedAt && isStaleTimestamp(entry.snapshot.cachedAt, QUOTA_STALE_MS)).length;
  const missing = entries.length - tracked;
  const nextReset = nextQuotaReset(entries, summaries);
  const resetLabel = nextReset ? formatResetLabel(nextReset) : undefined;
  return (
    <article className="mt-3 min-w-0 rounded-lg bg-white p-4 shadow-[0_1px_2px_rgba(23,33,27,0.08),0_12px_36px_rgba(23,33,27,0.08)]">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-[#17211b]">Quota coverage</div>
          <div className="mt-1 flex flex-wrap items-end gap-x-3 gap-y-1">
            <div className="numeric text-3xl font-semibold">{tracked}/{entries.length}</div>
            <div className="pb-1 text-xs text-[#59645d]">accounts with cached quota data</div>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <QuotaSummaryPill tone={low > 0 ? "bad" : "good"} label="Low quota" value={low} />
            <QuotaSummaryPill tone={missing > 0 ? "warn" : "good"} label="Missing" value={missing} />
            <QuotaSummaryPill tone={stale > 0 ? "warn" : "good"} label="Stale" value={stale} />
            <QuotaSummaryPill tone={resetLabel ? (isResetSoon(nextReset) ? "warn" : "neutral") : "neutral"} label="Next reset" value={resetLabel ?? "unknown"} />
          </div>
        </div>
        <StatusPill tone={low > 0 ? "bad" : missing > 0 || stale > 0 ? "warn" : tracked > 0 ? "good" : "neutral"}>
          {low > 0 ? "quota attention" : missing > 0 || stale > 0 ? "needs refresh" : tracked > 0 ? "fully readable" : "empty"}
        </StatusPill>
      </div>
      <div className="mt-4 max-h-[560px] min-w-0 overflow-auto rounded-lg shadow-[inset_0_0_0_1px_rgba(23,33,27,0.08)]">
        {entries.length > 0 ? (
          <table className="min-w-[960px] w-full border-separate border-spacing-0 text-left text-sm">
            <thead className="sticky top-0 z-10 bg-[#eef1e7] text-xs uppercase tracking-[0.08em] text-[#59645d]">
              <tr>
                <th className="px-3 py-3 font-semibold">Account</th>
                <th className="px-3 py-3 font-semibold">5h</th>
                <th className="px-3 py-3 font-semibold">Weekly</th>
                <th className="px-3 py-3 font-semibold">Next reset</th>
                <th className="px-3 py-3 font-semibold">Snapshot</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <QuotaAccountRow key={entry.account.id} entry={entry} />
              ))}
            </tbody>
          </table>
        ) : (
          <div className="rounded-lg bg-[#f7f8f3] p-3 text-sm text-[#59645d]">No accounts in this provider scope</div>
        )}
      </div>
    </article>
  );
}

function QuotaSummaryPill({ tone, label, value }: { tone: "good" | "warn" | "bad" | "neutral"; label: string; value: string | number }) {
  const className = tone === "good"
    ? "bg-[#dff3ee] text-[#116a61]"
    : tone === "warn"
      ? "bg-[#fff1c2] text-[#7a4d00]"
      : tone === "bad"
        ? "bg-[#ffe4df] text-[#b42318]"
        : "bg-[#eef1e7] text-[#59645d]";
  return (
    <span className={`inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium ${className}`}>
      <span>{label}</span>
      <span className="numeric font-semibold">{value}</span>
    </span>
  );
}

function QuotaAccountRow({ entry }: { entry: AccountQuotaEntry }) {
  const snapshot = entry.snapshot;
  const nextReset = snapshot ? quotaSnapshotResetAt(snapshot) : undefined;
  const minRemaining = snapshot ? minRemainingPercent(snapshot) : undefined;
  const stateTone = snapshot ? quotaTone(minRemaining) : "neutral";
  return (
    <tr className="border-t border-black/10 odd:bg-white even:bg-[#fbfcf7]">
      <td className="max-w-[280px] px-3 py-3 align-top">
        <div className="flex min-w-0 items-center gap-2 font-medium text-[#17211b]">
          <ProviderIcon provider={entry.account.provider} size={16} />
          <span className="truncate">{accountDisplayName(entry.account, { compact: true })}</span>
          {snapshot ? <StatusPill tone={stateTone}>{formatRemainingPercent(minRemaining)}</StatusPill> : null}
        </div>
        <div className="mt-1 truncate text-xs text-[#59645d]">
          {joinMeta([providerShortLabel(entry.account.provider), readPlan(entry.account) ?? "unknown plan", shorten(entry.account.id, 12)])}
        </div>
      </td>
      <td className="w-[150px] px-3 py-3 align-top"><QuotaWindowCell window={snapshot?.primary} /></td>
      <td className="w-[150px] px-3 py-3 align-top"><QuotaWindowCell window={snapshot?.secondary} /></td>
      <td className="w-[180px] px-3 py-3 align-top text-xs text-[#59645d]">
        {nextReset ? (
          <span title={formatFullTimestamp(nextReset)}>{formatResetLabel(nextReset)}</span>
        ) : (
          "Reset unknown"
        )}
      </td>
      <td className="w-[170px] px-3 py-3 align-top text-xs text-[#59645d]">
        {snapshot?.cachedAt ? (
          <span className={isStaleTimestamp(snapshot.cachedAt, QUOTA_STALE_MS) ? "font-medium text-[#7a4d00]" : ""} title={formatFullTimestamp(snapshot.cachedAt)}>
            {isStaleTimestamp(snapshot.cachedAt, QUOTA_STALE_MS) ? "stale " : ""}{relativeTime(snapshot.cachedAt)}
          </span>
        ) : (
          <span className="font-medium text-[#7a4d00]">No snapshot</span>
        )}
        {snapshot?.credits ? <div className="mt-1">Credits {snapshot.credits}</div> : null}
      </td>
    </tr>
  );
}

function QuotaWindowCell({ window }: { window: QuotaWindowSnapshot | undefined }) {
  if (!window) return <span className="text-xs text-[#8a948d]">-</span>;
  const remaining = window.remainingPercent;
  const width = remaining == null ? 0 : Math.max(0, Math.min(100, remaining));
  const tone = quotaTone(remaining);
  const color = tone === "good" ? "bg-[#35c46f]" : tone === "warn" ? "bg-[#f2b84b]" : tone === "bad" ? "bg-[#ef604d]" : "bg-[#8a948d]";
  return (
    <div className="min-w-0">
      <div className={`numeric text-xs font-semibold ${tone === "bad" ? "text-[#b42318]" : tone === "warn" ? "text-[#7a4d00]" : tone === "good" ? "text-[#116a61]" : "text-[#59645d]"}`}>
        {formatRemainingPercent(remaining)}
      </div>
      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-[#e0e5da]">
        <div className={`h-full rounded-full ${color} transition-[width] duration-300`} style={{ width: `${width}%` }} />
      </div>
      {window.resetAt ? (
        <div className="mt-1 truncate text-[11px] text-[#59645d]" title={formatFullTimestamp(window.resetAt)}>
          {formatResetLabel(window.resetAt)}
        </div>
      ) : null}
    </div>
  );
}

function QuotaSnapshotRow({ snapshot, compact }: { snapshot: AccountQuotaSnapshot; compact: boolean }) {
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is QuotaWindowSnapshot => Boolean(window),
  );
  return (
    <div className="min-w-0 rounded-lg bg-[#f7f8f3] p-3 shadow-[inset_0_0_0_1px_rgba(23,33,27,0.06)]">
      {!compact ? (
        <div className="mb-3 flex min-w-0 items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <ProviderIcon provider={snapshot.account.provider} size={16} />
              <div className="truncate text-sm font-semibold text-[#17211b]">{accountDisplayName(snapshot.account, { compact: true })}</div>
            </div>
            <div className="mt-0.5 truncate text-xs text-[#59645d]">
              {joinMeta([readPlan(snapshot.account) ?? "unknown plan", snapshot.cachedAt ? `cached ${relativeTime(snapshot.cachedAt)}` : undefined])}
            </div>
          </div>
          <StatusPill tone={quotaTone(minRemainingPercent(snapshot))}>{formatRemainingPercent(minRemainingPercent(snapshot))}</StatusPill>
        </div>
      ) : null}
      <div className={`grid gap-2 ${compact ? "" : "sm:grid-cols-2"}`}>
        {windows.length > 0 ? windows.map((window) => (
          <QuotaBar key={window.key} window={window} compact={compact} />
        )) : (
          <div className="text-xs text-[#59645d]">No quota snapshot</div>
        )}
      </div>
      {snapshot.credits && !compact ? (
        <div className="mt-2 text-xs text-[#59645d]">Credits {snapshot.credits}</div>
      ) : null}
    </div>
  );
}

function QuotaBar({ window, compact }: { window: QuotaWindowSnapshot; compact: boolean }) {
  const remaining = window.remainingPercent;
  const width = remaining == null ? 0 : Math.max(0, Math.min(100, remaining));
  const tone = quotaTone(remaining);
  const color = tone === "good" ? "bg-[#35c46f]" : tone === "warn" ? "bg-[#f2b84b]" : tone === "bad" ? "bg-[#ef604d]" : "bg-[#8a948d]";
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center justify-between gap-2 text-xs">
        <span className="truncate font-medium text-[#465149]">{window.label}</span>
        <span className={`numeric shrink-0 font-semibold ${tone === "bad" ? "text-[#b42318]" : tone === "warn" ? "text-[#7a4d00]" : tone === "good" ? "text-[#116a61]" : "text-[#59645d]"}`}>
          {formatRemainingPercent(remaining)}
        </span>
      </div>
      <div className={`${compact ? "mt-1 h-1.5" : "mt-1.5 h-2"} overflow-hidden rounded-full bg-[#e0e5da]`}>
        <div className={`h-full rounded-full ${color} transition-[width] duration-300`} style={{ width: `${width}%` }} />
      </div>
      {!compact ? (
        <div className="mt-1 truncate text-[11px] text-[#59645d]">
          {window.resetAt ? `Reset ${relativeTime(window.resetAt)}` : "Reset -"}
        </div>
      ) : null}
    </div>
  );
}

function UsageGraph({ buckets }: { buckets: UsageBucket[] }) {
  const max = Math.max(1, ...buckets.map((bucket) => bucket.total));
  return (
    <div className="mt-5 min-w-0">
      <div className="rounded-lg bg-white/[0.06] p-3 shadow-[inset_0_0_0_1px_rgba(255,255,255,0.08)]">
        <div className="mb-3 flex flex-wrap gap-3 text-xs text-white/60">
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-[#35c46f]" />Requests</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-[#f2b84b]" />Retries</span>
          <span className="inline-flex items-center gap-1"><span className="size-2 rounded-full bg-[#ef604d]" />Failures</span>
        </div>
        <div className="flex h-36 items-end gap-1">
        {buckets.map((bucket) => (
          <div key={bucket.label} className="flex min-w-0 flex-1 flex-col items-center gap-2">
            <div className="flex h-28 w-full items-end rounded-t-md bg-white/[0.04]" title={`${bucket.label}: ${bucket.total} requests, ${bucket.retried} retried, ${bucket.failed} failed`}>
              <div className="grid w-full items-end">
                <div
                  className="w-full rounded-t-md bg-[#35c46f] shadow-[0_0_16px_rgba(53,196,111,0.22)]"
                  style={{ height: `${Math.max(6, (bucket.total / max) * 112)}px`, gridArea: "1 / 1" }}
                />
                {bucket.retried > 0 ? (
                  <div
                    className="w-full rounded-t-md bg-[#f2b84b]"
                    style={{ height: `${Math.max(4, (bucket.retried / max) * 112)}px`, gridArea: "1 / 1" }}
                  />
                ) : null}
                {bucket.failed > 0 ? (
                  <div
                    className="w-full rounded-t-md bg-[#ef604d]"
                    style={{ height: `${Math.max(4, (bucket.failed / max) * 112)}px`, gridArea: "1 / 1" }}
                  />
                ) : null}
              </div>
            </div>
          </div>
        ))}
        </div>
      </div>
      <div className="mt-2 flex justify-between text-[10px] text-white/45">
        <span>{buckets[0]?.label ?? "-"}</span>
        <span>{buckets[buckets.length - 1]?.label ?? "-"}</span>
      </div>
    </div>
  );
}

function InsightMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg bg-white/10 p-3">
      <div className="numeric text-lg font-semibold">{value}</div>
      <div className="mt-1 text-xs text-white/55">{label}</div>
    </div>
  );
}

function AccountsTable(props: {
  accounts: AccountRecord[];
  status: AccountStatusSummary[];
  onAction(account: AccountRecord, action: "pause" | "reactivate" | "reset"): Promise<void>;
}) {
  if (props.accounts.length === 0) return <EmptyPanel label="No accounts match this filter" />;
  const groups = groupAccountsByProvider(props.accounts, props.status);
  return (
    <div className="max-w-full overflow-x-auto">
      <table className="min-w-[1080px] border-separate border-spacing-0 text-left text-sm">
        <thead className="bg-[#eef1e7] text-xs uppercase tracking-[0.08em] text-[#59645d]">
          <tr>
            <th className="px-4 py-3 font-semibold">Account</th>
            <th className="px-4 py-3 font-semibold">Status</th>
            <th className="px-4 py-3 font-semibold">Quota</th>
            <th className="px-4 py-3 font-semibold">Reason / recovery</th>
            <th className="px-4 py-3 font-semibold">Activity</th>
            <th className="px-4 py-3 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        {groups.map((group) => (
        <tbody key={group.provider} className="border-t border-black/10">
          <tr>
            <td colSpan={6} className="bg-[#f7f8f3] px-4 py-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <ProviderMark provider={group.provider} />
                <div className="flex flex-wrap gap-2 text-xs text-[#59645d]">
                  <span className="numeric rounded-md bg-white px-2 py-1">{group.accounts.length} visible</span>
                  <span className="numeric rounded-md bg-[#dff3ee] px-2 py-1 text-[#116a61]">{group.ready} ready</span>
                  {group.blocked > 0 ? (
                    <span className="numeric rounded-md bg-[#fff1c2] px-2 py-1 text-[#7a4d00]">{group.blocked} blocked</span>
                  ) : null}
                </div>
              </div>
            </td>
          </tr>
          {group.accounts.map((account) => {
            const state = readAccountState(account);
            return (
              <tr key={account.id} className="border-t border-black/10">
                <td className="max-w-[320px] px-4 py-3 align-top">
                  <div className="flex min-w-0 items-center gap-2 font-medium text-[#17211b]">
                    <ProviderIcon provider={account.provider} size={18} />
                    <span className="truncate">{accountDisplayName(account)}</span>
                  </div>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-[#59645d]">
                    <span>{readPlan(account) ?? "unknown plan"}</span>
                    <span className="numeric">{shorten(account.id, 12)}</span>
                  </div>
                </td>
                <td className="w-[170px] px-4 py-3 align-top">
                  <StatusPill tone={state.tone}>{state.label}</StatusPill>
                </td>
                <td className="w-[190px] px-4 py-3 align-top">
                  <AccountQuotaSummaryCell account={account} />
                </td>
                <td className="max-w-[280px] px-4 py-3 align-top text-[#59645d]">
                  <AccountReasonCell account={account} />
                </td>
                <td className="px-4 py-3 align-top text-xs text-[#59645d]">
                  <div>Used {account.lastUsedAt ? relativeTime(account.lastUsedAt) : "never"}</div>
                  <div className="mt-1">Error {account.lastErrorAt ? relativeTime(account.lastErrorAt) : "-"}</div>
                </td>
                <td className="px-4 py-3 align-top">
                  <div className="flex justify-end gap-2">
                    <IconButton label="Pause account" onClick={() => void props.onAction(account, "pause")}>
                      <PauseCircle size={16} aria-hidden="true" />
                    </IconButton>
                    <IconButton label="Reactivate account" onClick={() => void props.onAction(account, "reactivate")}>
                      <PlayCircle size={16} aria-hidden="true" />
                    </IconButton>
                    <IconButton label="Reset failure state" onClick={() => void props.onAction(account, "reset")}>
                      <RotateCcw size={16} aria-hidden="true" />
                    </IconButton>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
        ))}
      </table>
    </div>
  );
}

function AccountQuotaSummaryCell({ account }: { account: AccountRecord }) {
  const snapshot = buildAccountQuotaSnapshot(account);
  if (!snapshot) {
    return <div className="text-xs font-medium text-[#7a4d00]">No quota snapshot</div>;
  }
  const remaining = minRemainingPercent(snapshot);
  const bottleneck = quotaBottleneckLabel(snapshot);
  return (
    <div className="min-w-0">
      <StatusPill tone={quotaTone(remaining)}>{formatRemainingPercent(remaining)}</StatusPill>
      <div className="mt-1 truncate text-xs text-[#59645d]">{bottleneck ?? "cached quota"}</div>
    </div>
  );
}

function AccountReasonCell({ account }: { account: AccountRecord }) {
  const state = readAccountState(account);
  const recovery = accountRecoveryLabel(account);
  const reason = account.lastFailureMessage ?? account.lastFailureCode ?? defaultAccountReason(account, state.label);
  return (
    <div className="min-w-0">
      <div className="truncate text-sm text-[#59645d]">{reason}</div>
      <div className="mt-1 text-xs text-[#59645d]">
        {joinMeta([
          account.failureCount > 0 ? `${account.failureCount} failure${account.failureCount === 1 ? "" : "s"}` : undefined,
          recovery,
        ]) ?? "No action needed"}
      </div>
    </div>
  );
}

function defaultAccountReason(account: AccountRecord, stateLabel: string): string {
  if (stateLabel === "disabled") return "Manually disabled";
  if (stateLabel === "auth cooldown") return "Waiting for auth retry";
  if (stateLabel === "reauth required") return account.reauthRequiredReason ?? "Re-authentication required";
  if (stateLabel === "quota exceeded") return "Quota window is blocked";
  if (stateLabel === "rate limited") return "Rate limit window is blocked";
  return "Operational";
}

function accountRecoveryLabel(account: AccountRecord): string | undefined {
  const resetAt = accountResetAt(account);
  if (!resetAt) return undefined;
  const label = account.authCooldownUntil === resetAt ? "auth retry" : "next reset";
  return `${label} ${formatResetLabel(resetAt)}`;
}

function quotaBottleneckLabel(snapshot: AccountQuotaSnapshot): string | undefined {
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (candidate): candidate is QuotaWindowSnapshot => Boolean(candidate) && typeof candidate?.remainingPercent === "number",
  );
  if (windows.length === 0) return undefined;
  const bottleneck = windows.sort((left, right) => left.remainingPercent! - right.remainingPercent!)[0];
  return `${bottleneck.label} bottleneck`;
}

function RequestLogList({ logs, accountById }: { logs: RequestLogGroup[]; accountById: Map<string, AccountRecord> }) {
  if (logs.length === 0) return <EmptyPanel label="No request logs match this filter" />;
  return (
    <div className="mt-3 grid gap-2">
      {logs.map((log) => {
        const ok = !log.finalStatus || log.finalStatus < 400;
        const routeLabel = requestRouteLabel(log);
        const accountLabels = log.accountIds
          .map((id) => {
            const account = accountById.get(id);
            return account ? accountDisplayName(account, { compact: true }) : shorten(id, 12);
          })
          .slice(0, 3);
        const durationMs = durationBetween(log.startedAt, log.completedAt);
        const errorMessage = requestLogErrorMessage(log);
        return (
          <article key={log.requestId} className="min-w-0 rounded-lg bg-white p-4 shadow-[0_1px_2px_rgba(23,33,27,0.08)]">
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1.2fr)_minmax(180px,0.6fr)_auto] lg:items-start">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={ok ? "good" : "bad"}>{log.finalStatus ?? "open"}</StatusPill>
                  <span className="font-medium text-[#17211b]">{routeLabel}</span>
                  {labelHasProvider(routeLabel, log.provider) ? null : <ProviderMark provider={log.provider} label="short" />}
                </div>
                <div className="mt-2 flex flex-wrap gap-2 text-xs text-[#59645d]">
                  <span>{requestModelLabel(log)}</span>
                  <span className="numeric">{shorten(log.requestId, 16)}</span>
                  <span>{log.retryCount} retries</span>
                  <span>{durationMs != null ? `${formatDuration(durationMs)} duration` : "duration -"}</span>
                  <span>{relativeTime(log.startedAt)}</span>
                </div>
                {errorMessage ? <p className="mt-2 line-clamp-2 text-xs text-[#b42318]">{errorMessage}</p> : null}
              </div>
              <div className="min-w-0 text-xs text-[#59645d]">
                <div className="font-semibold uppercase tracking-[0.08em] text-[#8a948d]">Accounts</div>
                <div className="mt-1 grid gap-1">
                  {accountLabels.length > 0 ? accountLabels.map((label) => (
                    <div key={label} className="truncate">{label}</div>
                  )) : <div>-</div>}
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {log.events.slice(0, 5).map((event) => (
                  <span key={event.id} className="rounded-md bg-[#eef1e7] px-2 py-1 text-xs font-medium text-[#465149]">
                    {event.eventType}
                  </span>
                ))}
              </div>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function StickySessionSummary({ sessions, accountById }: { sessions: StickySession[]; accountById: Map<string, AccountRecord> }) {
  const recentSessions = sessions.filter((session) => !isOldRoutePin(session));
  const oldSessions = sessions.filter(isOldRoutePin);
  const stalePromptCache = sessions.filter(isStalePromptCache);
  const pinnedAccountIds = new Set(sessions.map((session) => session.accountId));
  const codexPins = sessions.filter((session) => session.provider === "codex").length;
  const claudePins = sessions.filter((session) => session.provider === "claude-code").length;
  const oldest = sessions
    .map((session) => session.updatedAt)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const blockedPinned = [...pinnedAccountIds]
    .map((id) => accountById.get(id))
    .filter((account): account is AccountRecord => Boolean(account))
    .filter((account) => readAccountState(account).tone !== "good").length;

  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <SessionSummaryCard label="Recent pins" value={recentSessions.length} detail={oldSessions.length > 0 ? `${oldSessions.length} old` : "last 24h"} tone={oldSessions.length > 0 ? "warn" : "good"} />
      <SessionSummaryCard label="Pinned accounts" value={pinnedAccountIds.size} detail={blockedPinned > 0 ? `${blockedPinned} blocked` : "ready map"} tone={blockedPinned > 0 ? "warn" : "good"} />
      <SessionSummaryCard label="Provider split" value={`${codexPins}/${claudePins}`} detail="Codex / Claude" tone="neutral" />
      <SessionSummaryCard label="Stale cache pins" value={stalePromptCache.length} detail={oldest ? `oldest ${relativeTime(oldest)}` : "prompt-cache TTL"} tone={stalePromptCache.length > 0 ? "warn" : "neutral"} />
    </div>
  );
}

function SessionSummaryCard(props: {
  label: string;
  value: string | number;
  detail: string;
  tone: "good" | "warn" | "neutral";
}) {
  const className = props.tone === "good"
    ? "bg-[#dff3ee] text-[#116a61]"
    : props.tone === "warn"
      ? "bg-[#fff8e6] text-[#7a4d00]"
      : "bg-white text-[#17211b]";
  return (
    <div className={`min-w-0 rounded-lg p-3 shadow-[0_1px_2px_rgba(23,33,27,0.08)] ${className}`}>
      <div className="text-xs opacity-75">{props.label}</div>
      <div className="numeric mt-1 truncate text-2xl font-semibold">{props.value}</div>
      <div className="mt-1 text-xs opacity-75">{props.detail}</div>
    </div>
  );
}

function StickySessionList(props: {
  sessions: StickySession[];
  accountById: Map<string, AccountRecord>;
  onDelete(session: StickySession): Promise<void>;
}) {
  if (props.sessions.length === 0) return <EmptyPanel label="No session route pins match this filter" />;
  return (
    <div className="mt-3 grid gap-2 lg:grid-cols-2">
      {props.sessions.map((session) => {
        const account = props.accountById.get(session.accountId);
        const accountState = account ? readAccountState(account) : undefined;
        return (
          <article key={session.key} className="min-w-0 rounded-lg bg-white p-4 shadow-[0_1px_2px_rgba(23,33,27,0.08)]">
            <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusPill tone={accountState?.tone ?? "neutral"}>{sessionKindLabel(session.kind)}</StatusPill>
                  {isOldRoutePin(session) ? <StatusPill tone="warn">Old pin</StatusPill> : null}
                  {isStalePromptCache(session) ? <StatusPill tone="warn">Stale cache</StatusPill> : null}
                  <ProviderMark provider={session.provider} label="short" />
                </div>
                <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
                  <SessionField label="Session key" value={session.sessionKey || session.key} mono />
                  <SessionField
                    label="Pinned account"
                    value={account ? accountDisplayName(account, { compact: true }) : shorten(session.accountId, 18)}
                    detail={account ? joinMeta([readPlan(account), accountState?.label]) : shorten(session.accountId, 18)}
                  />
                  <SessionField label="Binding key" value={session.key} mono />
                  <SessionField label="Last routed" value={relativeTime(session.updatedAt)} detail={session.expiresAt ? `cache expires ${relativeTime(session.expiresAt)}` : `created ${relativeTime(session.createdAt)}`} />
                </div>
              </div>
              <button
                type="button"
                className="focus-ring inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#eef1e7] px-3 text-sm font-medium text-[#465149] transition-transform duration-150 hover:bg-[#dff3ee] active:scale-[0.96]"
                onClick={() => void props.onDelete(session)}
                title="Release route pin"
              >
                <Trash2 size={16} aria-hidden="true" />
                Release
              </button>
            </div>
          </article>
        );
      })}
    </div>
  );
}

function SessionField(props: { label: string; value: string; detail?: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#8a948d]">{props.label}</div>
      <div className={`mt-1 truncate text-[#17211b] ${props.mono ? "numeric font-mono text-xs" : "font-medium"}`} title={props.value}>
        {props.value}
      </div>
      {props.detail ? <div className="mt-0.5 truncate text-xs text-[#59645d]">{props.detail}</div> : null}
    </div>
  );
}

function CommandPalette(props: {
  open: boolean;
  query: string;
  setQuery(value: string): void;
  commands: Command[];
  selectedIndex: number;
  inputRef: RefObject<HTMLInputElement | null>;
  onClose(): void;
  onKeyDown(event: KeyboardEvent<HTMLInputElement>): void;
  onRun(command: Command | undefined): Promise<void>;
}) {
  return (
    <AnimatePresence>
      {props.open ? (
        <motion.div
          className="fixed inset-0 z-50 bg-[#17211b]/36 p-4 backdrop-blur-sm"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onMouseDown={props.onClose}
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Command palette"
            className="mx-auto mt-16 max-w-2xl overflow-hidden rounded-lg bg-white shadow-[0_24px_72px_rgba(23,33,27,0.28)]"
            initial={{ opacity: 0, y: -8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ type: "spring", duration: 0.3, bounce: 0 }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-center gap-2 border-b border-black/10 px-4">
              <Search size={18} className="text-[#59645d]" aria-hidden="true" />
              <input
                ref={props.inputRef}
                value={props.query}
                onChange={(event) => props.setQuery(event.target.value)}
                onKeyDown={props.onKeyDown}
                className="min-h-14 flex-1 bg-transparent text-base outline-none placeholder:text-[#8a948d]"
                placeholder="Search"
                aria-label="Search commands"
              />
              <button
                type="button"
                className="focus-ring flex size-10 items-center justify-center rounded-lg text-[#59645d] transition-colors duration-150 hover:bg-[#eef1e7]"
                onClick={props.onClose}
                aria-label="Close command palette"
              >
                <X size={18} aria-hidden="true" />
              </button>
            </div>
            <div className="max-h-[60dvh] overflow-y-auto p-2">
              {props.commands.length === 0 ? (
                <div className="px-3 py-8 text-center text-sm text-[#59645d]">No commands found</div>
              ) : props.commands.map((command, index) => (
                <button
                  key={command.id}
                  type="button"
                  className={`focus-ring flex min-h-12 w-full items-center gap-3 rounded-lg px-3 text-left transition-colors duration-150 ${
                    index === props.selectedIndex ? "bg-[#dff3ee]" : "hover:bg-[#eef1e7]"
                  }`}
                  onMouseEnter={() => undefined}
                  onClick={() => void props.onRun(command)}
                >
                  <CommandIcon kind={command.icon} dangerous={command.dangerous} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-[#17211b]">{command.label}</span>
                    <span className="block truncate text-xs text-[#59645d]">{command.meta}</span>
                  </span>
                  <ArrowUpRight size={15} className="text-[#8a948d]" aria-hidden="true" />
                </button>
              ))}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function CommandIcon(props: { kind: Command["icon"]; dangerous?: boolean }) {
  const className = props.dangerous ? "text-[#b42318]" : "text-[#116a61]";
  const icon = props.kind === "pause" ? <PauseCircle size={16} aria-hidden="true" />
    : props.kind === "reactivate" ? <PlayCircle size={16} aria-hidden="true" />
    : props.kind === "reset" ? <RotateCcw size={16} aria-hidden="true" />
    : props.kind === "delete" ? <Trash2 size={16} aria-hidden="true" />
    : props.kind === "filter" ? <CircleDashed size={16} aria-hidden="true" />
    : <ArrowUpRight size={16} aria-hidden="true" />;
  return (
    <span className={`flex size-9 shrink-0 items-center justify-center rounded-lg bg-[#eef1e7] ${className}`}>
      {icon}
    </span>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      className="focus-ring flex size-10 items-center justify-center rounded-lg bg-[#eef1e7] text-[#465149] transition-transform duration-150 hover:bg-[#dff3ee] active:scale-[0.96]"
      onClick={onClick}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

function EmptyPanel({ label }: { label: string }) {
  return (
    <div className="rounded-lg bg-white p-6 text-sm text-[#59645d] shadow-[0_1px_2px_rgba(23,33,27,0.08)]">
      {label}
    </div>
  );
}

function StatusPill({ tone, children }: { tone: "good" | "warn" | "bad" | "neutral"; children: ReactNode }) {
  const className = tone === "good"
    ? "bg-[#dff3ee] text-[#116a61]"
    : tone === "warn"
      ? "bg-[#fff1c2] text-[#7a4d00]"
      : tone === "bad"
        ? "bg-[#ffe4df] text-[#b42318]"
        : "bg-[#eef1e7] text-[#59645d]";
  return (
    <span className={`inline-flex min-h-7 items-center rounded-md px-2 text-xs font-semibold ${className}`}>
      {children}
    </span>
  );
}

function readAccountState(account: AccountRecord): { label: string; tone: "good" | "warn" | "bad" | "neutral" } {
  const now = Date.now();
  if (account.reauthRequiredReason) return { label: "reauth required", tone: "bad" };
  if (!account.enabled) return { label: "disabled", tone: "neutral" };
  if (isFuture(account.authCooldownUntil, now)) return { label: "auth cooldown", tone: "warn" };
  if (isFuture(account.rateLimitResetAt, now) || isFuture(account.rateLimitCooldownUntil, now)) {
    return { label: account.lastFailureClass === "quota" ? "quota exceeded" : "rate limited", tone: "warn" };
  }
  return { label: "ready", tone: "good" };
}

function buildAccountQuotaSnapshots(accounts: AccountRecord[]): AccountQuotaSnapshot[] {
  return buildAccountQuotaEntries(accounts)
    .map((entry) => entry.snapshot)
    .filter((snapshot): snapshot is AccountQuotaSnapshot => Boolean(snapshot));
}

function buildAccountQuotaEntries(accounts: AccountRecord[]): AccountQuotaEntry[] {
  return accounts
    .map(buildAccountQuotaSnapshot)
    .map((snapshot, index) => ({ account: accounts[index]!, snapshot }))
    .sort((left, right) => {
      const leftRank = quotaEntryRank(left);
      const rightRank = quotaEntryRank(right);
      const leftRemaining = left.snapshot ? minRemainingPercent(left.snapshot) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
      const rightRemaining = right.snapshot ? minRemainingPercent(right.snapshot) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY;
      return leftRank - rightRank ||
        leftRemaining - rightRemaining ||
        accountStableSortName(left.account).localeCompare(accountStableSortName(right.account)) ||
        left.account.id.localeCompare(right.account.id);
    });
}

function buildAccountQuotaSnapshot(account: AccountRecord): AccountQuotaSnapshot | undefined {
  const metadata = account.metadata ?? {};
  const usage = readRecord(metadata.cachedUsage) ?? readRecord(metadata.usage);
  const directUsage = readRecord(metadata.usage);
  const primary = readUsageWindow(usage, ["five_hour", "primary", "primary_window", "5h"], "primary", "5h") ??
    readDirectRemainingWindow(directUsage, "primaryRemainingPercent", "primary", "5h");
  const secondary = readUsageWindow(usage, ["seven_day", "secondary", "secondary_window", "weekly"], "secondary", "Weekly") ??
    readDirectRemainingWindow(directUsage, "secondaryRemainingPercent", "secondary", "Weekly");
  const credits = readCreditsLabel(readRecord(usage?.credits) ?? readRecord(directUsage?.credits));
  const cachedAt = readTimestamp(metadata.cachedUsageAt ?? metadata.usageCachedAt ?? metadata.usage_cached_at);

  if (!primary && !secondary && !credits) return undefined;
  return { account, primary, secondary, credits, cachedAt };
}

function readUsageWindow(
  usage: Record<string, unknown> | undefined,
  keys: string[],
  key: QuotaWindowSnapshot["key"],
  label: string,
): QuotaWindowSnapshot | undefined {
  if (!usage) return undefined;
  const window = keys.map((candidate) => readRecord(usage[candidate])).find(Boolean);
  if (!window) return undefined;
  const usedPercent = clampPercent(readOptionalNumber(
    window.utilization ?? window.used_percent ?? window.usedPercent ?? window.percent_used,
  ));
  const remainingPercent = clampPercent(readOptionalNumber(
    window.remaining_percent ?? window.remainingPercent ?? window.remaining_percent_avg ?? window.remainingPercentAvg,
  ) ?? (usedPercent == null ? undefined : 100 - usedPercent));
  const resetAt = readTimestamp(window.reset_at ?? window.resetAt ?? window.resets_at ?? window.resetsAt);

  if (usedPercent == null && remainingPercent == null && !resetAt) return undefined;
  return { key, label, usedPercent, remainingPercent, resetAt };
}

function readDirectRemainingWindow(
  usage: Record<string, unknown> | undefined,
  field: string,
  key: QuotaWindowSnapshot["key"],
  label: string,
): QuotaWindowSnapshot | undefined {
  const remainingPercent = clampPercent(readOptionalNumber(usage?.[field]));
  if (remainingPercent == null) return undefined;
  return { key, label, remainingPercent, usedPercent: 100 - remainingPercent };
}

function minRemainingPercent(snapshot: AccountQuotaSnapshot): number | undefined {
  const values = [snapshot.primary, snapshot.secondary]
    .map((window) => window?.remainingPercent)
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? Math.min(...values) : undefined;
}

function quotaSnapshotResetAt(snapshot: AccountQuotaSnapshot): string | undefined {
  return nearestTimestamp([snapshot.primary?.resetAt, snapshot.secondary?.resetAt]);
}

function nextQuotaReset(entries: AccountQuotaEntry[], summaries: AccountStatusSummary[]): string | undefined {
  return nearestTimestamp([
    ...entries.flatMap((entry) => entry.snapshot ? [entry.snapshot.primary?.resetAt, entry.snapshot.secondary?.resetAt] : []),
    ...summaries.flatMap((summary) => [summary.next_reset_at, summary.next_auth_retry_at]),
  ]);
}

function nearestTimestamp(values: Array<string | undefined>): string | undefined {
  const parsed = values
    .map((value) => {
      const time = value ? Date.parse(value) : Number.NaN;
      return { value, time };
    })
    .filter((entry): entry is { value: string; time: number } => Boolean(entry.value) && Number.isFinite(entry.time));
  const now = Date.now();
  const future = parsed.filter((entry) => entry.time >= now).sort((left, right) => left.time - right.time);
  if (future[0]) return future[0].value;
  return parsed.sort((left, right) => right.time - left.time)[0]?.value;
}

function isLowQuota(snapshot: AccountQuotaSnapshot): boolean {
  const remaining = minRemainingPercent(snapshot);
  return remaining != null && remaining <= QUOTA_LOW_PERCENT;
}

function quotaEntryRank(entry: AccountQuotaEntry): number {
  if (!entry.snapshot) return 2;
  if (isLowQuota(entry.snapshot)) return 0;
  if (entry.snapshot.cachedAt && isStaleTimestamp(entry.snapshot.cachedAt, QUOTA_STALE_MS)) return 1;
  return 3;
}

function quotaTone(value: number | undefined): "good" | "warn" | "bad" | "neutral" {
  if (value == null) return "neutral";
  if (value <= QUOTA_LOW_PERCENT) return "bad";
  if (value <= 45) return "warn";
  return "good";
}

function buildTrafficInsights(
  logs: RequestLogGroup[],
  accounts: AccountRecord[],
  sessions: StickySession[],
  accountById: Map<string, AccountRecord>,
): TrafficInsights {
  const failures = logs.filter(isFailedLog).length;
  const retried = logs.filter((log) => log.retryCount > 0).length;
  const durations = logs
    .map((log) => durationBetween(log.startedAt, log.completedAt))
    .filter((value): value is number => typeof value === "number")
    .sort((a, b) => a - b);
  const modelMap = new Map<string, BreakdownItem>();
  const routeMap = new Map<string, BreakdownItem>();
  const accountMap = new Map<string, BreakdownItem>();
  const sessionMap = new Map<string, BreakdownItem>();

  for (const log of logs) {
    const failed = isFailedLog(log);
    const model = readModelBreakdown(log);
    incrementBreakdown(modelMap, model.id, model.label, joinMeta([model.meta, failed ? "has failures" : undefined]) ?? "", failed);
    const route = requestRouteLabel(log);
    incrementBreakdown(routeMap, route, route, joinMeta([providerLabel(log.provider), log.retryCount > 0 ? `${log.retryCount} retries` : undefined]) ?? "", failed);
    for (const accountId of log.accountIds) {
      const account = accountById.get(accountId);
      const label = account ? accountDisplayName(account, { compact: true }) : shorten(accountId, 18);
      const state = account ? readAccountState(account).label : "unknown account";
      incrementBreakdown(accountMap, accountId, label, joinMeta([providerLabel(log.provider), state]) ?? "", failed);
    }
  }

  const accountProviderById = new Map(accounts.map((account) => [account.id, account.provider]));
  for (const session of sessions) {
    const account = accountById.get(session.accountId);
    const label = account ? accountDisplayName(account, { compact: true }) : shorten(session.accountId, 18);
    const provider = accountProviderById.get(session.accountId) ?? session.provider;
    incrementBreakdown(sessionMap, session.accountId, label, joinMeta([providerLabel(provider), session.kind]) ?? "", false);
  }

  return {
    total: logs.length,
    failures,
    retried,
    successRate: percentage(logs.length - failures, logs.length),
    retryRate: percentage(retried, logs.length),
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    avgMs: average(durations),
    buckets: buildRequestBuckets(logs),
    models: sortBreakdown(modelMap),
    routes: sortBreakdown(routeMap),
    accounts: sortBreakdown(accountMap),
    sessions: sortBreakdown(sessionMap),
  };
}

function incrementBreakdown(
  map: Map<string, BreakdownItem>,
  id: string,
  label: string,
  meta: string,
  failed: boolean,
) {
  const current = map.get(id);
  if (current) {
    current.value += 1;
    current.failed += failed ? 1 : 0;
    if (failed) current.meta = meta;
    return;
  }
  map.set(id, { id, label, value: 1, failed: failed ? 1 : 0, meta });
}

function sortBreakdown(map: Map<string, BreakdownItem>): BreakdownItem[] {
  return [...map.values()].sort((a, b) => b.value - a.value || b.failed - a.failed || a.label.localeCompare(b.label));
}

function buildRequestBuckets(logs: RequestLogGroup[]): UsageBucket[] {
  const bucketCount = 12;
  const spanMs = 24 * 3_600_000;
  const bucketMs = spanMs / bucketCount;
  const end = Date.now();
  const start = end - spanMs;
  const buckets = Array.from({ length: bucketCount }, (_, index) => {
    const time = new Date(start + index * bucketMs);
    return {
      label: time.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
      total: 0,
      failed: 0,
      retried: 0,
    };
  });

  for (const log of logs) {
    const started = Date.parse(log.startedAt);
    if (!Number.isFinite(started) || started < start || started > end) continue;
    const index = Math.min(bucketCount - 1, Math.max(0, Math.floor((started - start) / bucketMs)));
    buckets[index].total += 1;
    if (isFailedLog(log)) buckets[index].failed += 1;
    if (log.retryCount > 0) buckets[index].retried += 1;
  }
  return buckets;
}

function isFailedLog(log: RequestLogGroup): boolean {
  return typeof log.finalStatus === "number" && log.finalStatus >= 400;
}

function requestLogErrorMessage(log: RequestLogGroup): string | undefined {
  if (!isFailedLog(log)) return undefined;
  return log.events.find((event) => event.eventType !== "metadata" && event.message)?.message;
}

function inheritRequestLogSessionModels(logs: RequestLogGroup[]): RequestLogGroup[] {
  const latestModelBySession = new Map<string, string>();
  const distinctModelsBySession = new Map<string, Set<string>>();
  const chronologicalLogs = logs.slice().sort((left, right) =>
    left.startedAt.localeCompare(right.startedAt) || left.completedAt.localeCompare(right.completedAt)
  );

  const hydrated = new Map<RequestLogGroup, RequestLogGroup>();
  for (const log of chronologicalLogs) {
    if (log.model) {
      latestModelBySession.set(log.sessionKey, log.model);
      const models = distinctModelsBySession.get(log.sessionKey) ?? new Set<string>();
      models.add(log.model);
      distinctModelsBySession.set(log.sessionKey, models);
      continue;
    }

    const inheritedModel = latestModelBySession.get(log.sessionKey);
    if (inheritedModel) hydrated.set(log, { ...log, model: inheritedModel });
  }

  for (const log of chronologicalLogs) {
    if (log.model || hydrated.has(log)) continue;
    const models = distinctModelsBySession.get(log.sessionKey);
    if (models?.size === 1) hydrated.set(log, { ...log, model: [...models][0] });
  }

  return logs.map((log) => hydrated.get(log) ?? log);
}

function readModelBreakdown(log: RequestLogGroup): { id: string; label: string; meta: string } {
  if (log.model) {
    return {
      id: log.model,
      label: log.model,
      meta: providerLabel(log.provider),
    };
  }
  if (isCodexBackendResponseSync(log)) {
    return {
      id: "codex-backend-response-sync",
      label: "Backend response sync",
      meta: "Codex backend call without a request model field",
    };
  }
  if (log.provider === "codex" && log.route === "/backend-api/codex/responses" && log.finalStatus === 101) {
    return {
      id: "codex-websocket-opening",
      label: "Opening WebSocket",
      meta: "Model arrives later in response.create metadata",
    };
  }
  return {
    id: `${log.provider}:model-not-logged`,
    label: "Model not logged",
    meta: providerLabel(log.provider),
  };
}

function percentage(value: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((value / total) * 100);
}

function percentile(values: number[], ratio: number): number | undefined {
  if (values.length === 0) return undefined;
  const index = Math.min(values.length - 1, Math.max(0, Math.ceil(values.length * ratio) - 1));
  return values[index];
}

function average(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function matchesAccountStateFilter(account: AccountRecord, filter: AccountStateFilter): boolean {
  const state = readAccountState(account);
  if (filter === "all") return true;
  if (filter === "ready") return state.tone === "good";
  if (filter === "blocked") return state.tone !== "good";
  if (filter === "rate_limited") return state.label === "rate limited";
  if (filter === "quota") return state.label === "quota exceeded";
  if (filter === "auth") return state.label === "auth cooldown" || state.label === "reauth required";
  if (filter === "disabled") return state.label === "disabled";
  return true;
}

function groupAccountsByProvider(accounts: AccountRecord[], summaries: AccountStatusSummary[]): AccountProviderGroup[] {
  const summaryByProvider = new Map(summaries.map((summary) => [summary.provider, summary]));
  const providers = new Set<ProviderId>([
    ...summaries.map((summary) => summary.provider),
    ...accounts.map((account) => account.provider),
  ]);

  return [...providers]
    .sort((left, right) => providerLabel(left).localeCompare(providerLabel(right)))
    .flatMap((provider): AccountProviderGroup[] => {
      const providerAccounts = sortAccountsForOperations(accounts.filter((account) => account.provider === provider));
      if (providerAccounts.length === 0) return [];
      const ready = providerAccounts.filter((account) => readAccountState(account).tone === "good").length;
      return [{
        provider,
        accounts: providerAccounts,
        summary: summaryByProvider.get(provider),
        ready,
        blocked: providerAccounts.length - ready,
      }];
    });
}

function sortAccountsForOperations(accounts: AccountRecord[]): AccountRecord[] {
  return [...accounts].sort((left, right) => (
    accountOperationRank(left) - accountOperationRank(right)
    || resetTimestamp(left) - resetTimestamp(right)
    || accountStableSortName(left).localeCompare(accountStableSortName(right))
    || left.id.localeCompare(right.id)
  ));
}

function accountOperationRank(account: AccountRecord): number {
  const now = Date.now();
  if (account.reauthRequiredReason) return 0;
  if (!account.enabled) return 1;
  if (isFuture(account.authCooldownUntil, now)) return 2;
  if (isFuture(account.rateLimitResetAt, now) || isFuture(account.rateLimitCooldownUntil, now)) {
    return account.lastFailureClass === "quota" ? 3 : 4;
  }
  if (account.failureCount > 0) return 5;
  return 6;
}

function matchesLogStatusFilter(log: RequestLogGroup, filter: LogStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "retry") return log.retryCount > 0;
  const failed = typeof log.finalStatus === "number" && log.finalStatus >= 400;
  if (filter === "failed") return failed;
  if (filter === "success") return !failed;
  return true;
}

function matchesLogTimeframe(log: RequestLogGroup, timeframe: LogTimeframe): boolean {
  if (timeframe === "all") return true;
  const started = Date.parse(log.startedAt);
  if (!Number.isFinite(started)) return true;
  const hours = timeframe === "1h" ? 1 : timeframe === "24h" ? 24 : 24 * 7;
  return Date.now() - started <= hours * 3_600_000;
}

function resetTimestamp(account: AccountRecord): number {
  const resetAt = accountResetAt(account);
  const parsed = resetAt ? Date.parse(resetAt) : Number.POSITIVE_INFINITY;
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function accountResetAt(account: AccountRecord): string | undefined {
  const values = [
    account.rateLimitResetAt,
    account.rateLimitCooldownUntil,
    account.authCooldownUntil,
  ]
    .map((value) => {
      const parsed = value ? Date.parse(value) : Number.POSITIVE_INFINITY;
      return { value, parsed };
    })
    .filter((entry): entry is { value: string; parsed: number } => Boolean(entry.value) && Number.isFinite(entry.parsed))
    .sort((left, right) => left.parsed - right.parsed);
  return values[0]?.value;
}

function accountStableSortName(account: AccountRecord): string {
  return accountDisplayName(account, { compact: true }).toLowerCase();
}

function requestRouteLabel(log: RequestLogGroup): string {
  if (log.route) return log.route;
  const eventRoute = log.events.find((event) => event.route)?.route;
  if (eventRoute) return eventRoute;
  if (log.provider === "codex") {
    if (log.model) return "Codex responses";
    return log.sessionKey.startsWith("file:") ? "Codex file request" : "Codex request";
  }
  if (log.provider === "claude-code") return "Claude messages";
  return "Gateway request";
}

function requestModelLabel(log: RequestLogGroup): string {
  const model = displayModelName(log.model);
  if (model) return model;
  if (isCodexBackendResponseSync(log)) return "backend response sync";
  if (log.provider === "codex" && log.route === "/backend-api/codex/responses" && log.finalStatus === 101) {
    return "opening websocket";
  }
  return "model not logged";
}

function isCodexBackendResponseSync(log: RequestLogGroup): boolean {
  return log.provider === "codex" &&
    log.route === "/backend-api/codex/responses" &&
    !log.model &&
    log.finalStatus === 200;
}

function readPlan(account: AccountRecord): string | undefined {
  const metadata = account.metadata ?? {};
  const value = metadata.planType ?? metadata.plan_type ?? metadata.planTier ?? metadata.plan ?? metadata.email;
  return typeof value === "string" ? value : undefined;
}

function durationBetween(start: string, end: string): number | undefined {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined;
  return Math.max(0, endMs - startMs);
}

function formatDuration(value: number): string {
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${Math.round(value / 100) / 10}s`;
  return `${Math.round(value / 60_000)}m`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readTimestamp(value: unknown): string | undefined {
  const stringValue = readString(value);
  if (stringValue) return stringValue;
  const numberValue = readOptionalNumber(value);
  if (numberValue == null) return undefined;
  const millis = numberValue < 10_000_000_000 ? numberValue * 1000 : numberValue;
  const date = new Date(millis);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function readCreditsLabel(credits: Record<string, unknown> | undefined): string | undefined {
  if (!credits) return undefined;
  if (credits.unlimited === true) return "unlimited";
  const balance = credits.balance ?? credits.remainingCredits ?? credits.remaining_credits;
  const numberValue = readOptionalNumber(balance);
  if (numberValue != null) return numberValue.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return readString(balance);
}

function clampPercent(value: number | undefined): number | undefined {
  if (value == null) return undefined;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function formatRemainingPercent(value: number | undefined): string {
  return value == null ? "-" : `${value}% left`;
}

function isFuture(value: string | undefined, now: number): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > now;
}

function isStaleTimestamp(value: string, thresholdMs: number): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && Date.now() - parsed > thresholdMs;
}

function isResetSoon(value: string | undefined): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return false;
  const diff = parsed - Date.now();
  return diff >= 0 && diff <= QUOTA_RESET_SOON_MS;
}

function formatResetLabel(value: string): string {
  return `${relativeTime(value)} · ${formatLocalClock(value)}`;
}

function formatLocalClock(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(parsed);
}

function formatFullTimestamp(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "long",
  }).format(parsed);
}

function relativeTime(value: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return value;
  const diff = parsed - Date.now();
  const abs = Math.abs(diff);
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 86_400_000],
    ["hour", 3_600_000],
    ["minute", 60_000],
    ["second", 1_000],
  ];
  const [unit, size] = units.find(([, candidate]) => abs >= candidate) ?? ["second", 1_000];
  const count = Math.round(diff / size);
  return new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(count, unit);
}

function providerLabel(provider: ProviderId): string {
  return provider === "claude-code" ? "Claude Code" : "Codex";
}

function providerShortLabel(provider: ProviderId): string {
  return provider === "claude-code" ? "Claude" : "Codex";
}

function sessionKindLabel(kind: string): string {
  if (kind === "codex_session") return "Codex follow-up";
  if (kind === "sticky_thread") return "Thread follow-up";
  if (kind === "prompt_cache") return "Prompt-cache pin";
  return kind
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ") || "Route pin";
}

function isStalePromptCache(session: StickySession): boolean {
  if (session.kind !== "prompt_cache") return false;
  if (typeof session.isStale === "boolean") return session.isStale;
  return ageSeconds(session.updatedAt) >= 30 * 60;
}

function isOldRoutePin(session: StickySession): boolean {
  if (typeof session.oldRoutePin === "boolean") return session.oldRoutePin;
  return ageSeconds(session.updatedAt) >= 24 * 60 * 60;
}

function ageSeconds(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return 0;
  return Math.max(0, Math.floor((Date.now() - time) / 1000));
}

function accountDisplayName(account: AccountRecord, options: { compact?: boolean } = {}): string {
  const name = account.name || readString(account.metadata?.email) || account.id;
  if (!options.compact) return name;
  return stripProviderPrefix(name, account.provider);
}

function stripProviderPrefix(value: string, provider: ProviderId): string {
  const prefixes = provider === "claude-code"
    ? ["Claude Code ", "Claude "]
    : ["Codex ", "OpenAI "];
  for (const prefix of prefixes) {
    if (value.toLowerCase().startsWith(prefix.toLowerCase())) {
      return value.slice(prefix.length).trim() || value;
    }
  }
  return value;
}

function labelHasProvider(value: string, provider: ProviderId): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith(providerLabel(provider).toLowerCase()) ||
    normalized.startsWith(providerShortLabel(provider).toLowerCase());
}

function displayModelName(model: string | undefined): string | undefined {
  if (!model) return undefined;
  return model
    .replace(/^openai\//, "")
    .replace(/^anthropic\//, "")
    .replace(/^claude-code\//, "");
}

function joinMeta(values: Array<string | number | undefined | null | false>): string | undefined {
  const normalized = values
    .map((value) => typeof value === "number" ? String(value) : value)
    .filter((value): value is string => Boolean(value && value.trim()))
    .map((value) => value.trim());
  const unique = normalized.filter((value, index) =>
    normalized.findIndex((candidate) => candidate.toLowerCase() === value.toLowerCase()) === index
  );
  return unique.length > 0 ? unique.join(" · ") : undefined;
}

function shorten(value: string, size: number): string {
  if (value.length <= size) return value;
  const head = Math.max(4, Math.floor((size - 1) / 2));
  const tail = Math.max(4, size - head - 1);
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

function readApiError(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== "object") return undefined;
  const message = (error as Record<string, unknown>).message;
  return typeof message === "string" ? message : undefined;
}

export const dashboardTestIds = {
  tokenPrompt: "token-prompt",
};
