import { ANSI } from "./ansi";
import { select, type MenuItem } from "./select";
import { confirm } from "./confirm";
import { getAccountLabel } from "../utils";
import { getPlanLabel } from "../usage";
import type { AccountSelectionStrategy, ManagedAccount, UsageLimits } from "../types";

export type AuthMenuAction =
  | { type: "add" }
  | { type: "check-quotas" }
  | { type: "manage" }
  | { type: "load-balancing" }
  | { type: "delete-all" }
  | { type: "cancel" };

export type AccountAction = "back" | "toggle" | "delete" | "retry-auth" | "cancel";

function formatRelativeTime(timestamp: number | undefined): string {
  if (!timestamp) return "never";
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  return new Date(timestamp).toLocaleDateString();
}

function formatDate(timestamp: number | undefined): string {
  if (!timestamp) return "unknown";
  return new Date(timestamp).toLocaleDateString();
}

type AccountStatus = "active" | "rate-limited" | "auth-disabled" | "disabled";

function getAccountStatus(account: ManagedAccount): AccountStatus {
  if (account.isAuthDisabled) return "auth-disabled";
  if (!account.enabled) return "disabled";
  if (account.rateLimitResetAt && account.rateLimitResetAt > Date.now()) return "rate-limited";
  return "active";
}

const STATUS_BADGE: Record<AccountStatus, string> = {
  "active": `${ANSI.green}[active]${ANSI.reset}`,
  "rate-limited": `${ANSI.yellow}[rate-limited]${ANSI.reset}`,
  "auth-disabled": `${ANSI.red}[auth-disabled]${ANSI.reset}`,
  "disabled": `${ANSI.red}[disabled]${ANSI.reset}`,
};

function buildAccountMenuItem(account: ManagedAccount): MenuItem<ManagedAccount> {
  const label = getAccountLabel(account);
  const status = getAccountStatus(account);
  const badge = STATUS_BADGE[status];
  const fullLabel = `${label} ${badge}`;

  return {
    label: fullLabel,
    hint: account.lastUsed ? `used ${formatRelativeTime(account.lastUsed)}` : "",
    value: account,
    disabled: false,
  };
}

export async function showAuthMenu(accounts: ManagedAccount[]): Promise<AuthMenuAction> {
  const items: MenuItem<AuthMenuAction>[] = [
    { label: "Add new account", value: { type: "add" }, color: "green" },
    { label: "Check quotas", value: { type: "check-quotas" }, color: "cyan" },
    { label: "Manage accounts", value: { type: "manage" } },
    { label: "Load balancing", value: { type: "load-balancing" } },
    { label: "", value: { type: "cancel" }, separator: true },
    { label: "Delete all accounts", value: { type: "delete-all" }, color: "red" },
  ];

  while (true) {
    const subtitle = `${accounts.length} account(s) registered`;
    const result = await select(items, {
      message: "Claude Multi-Auth",
      subtitle,
    });

    if (!result) return { type: "cancel" };

    if (result.type === "delete-all") {
      const confirmed = await confirm("Delete ALL accounts? This cannot be undone.");
      if (!confirmed) continue;
    }

    return result;
  }
}

export async function showManageAccounts(accounts: ManagedAccount[]): Promise<{ action: AccountAction; account?: ManagedAccount }> {
  const items: MenuItem<ManagedAccount | null>[] = [
    { label: "Back", value: null },
    { label: "", value: null, separator: true },
    ...accounts.map(buildAccountMenuItem),
  ];

  const selected = await select(items, {
    message: "Manage Accounts",
    subtitle: "Select an account to manage",
  });

  if (!selected) return { action: "back" };

  return showAccountDetails(selected);
}

async function showAccountDetails(account: ManagedAccount): Promise<{ action: AccountAction; account: ManagedAccount }> {
  const label = getAccountLabel(account);
  const status = getAccountStatus(account);
  const badge = STATUS_BADGE[status];

  console.log("");
  console.log(`${ANSI.bold}Account: ${label} ${badge}${ANSI.reset}`);
  console.log(`${ANSI.dim}Added: ${formatDate(account.addedAt)}${ANSI.reset}`);
  console.log(`${ANSI.dim}Last used: ${formatRelativeTime(account.lastUsed)}${ANSI.reset}`);
  if (account.isAuthDisabled) {
    console.log(`${ANSI.red}Auth disabled: ${account.authDisabledReason ?? "unknown"}${ANSI.reset}`);
  }
  console.log("");

  while (true) {
    const toggleLabel = account.enabled ? "Disable account" : "Enable account";
    const toggleColor = account.enabled ? "yellow" as const : "green" as const;

    const items: MenuItem<AccountAction>[] = [
      { label: "Back", value: "back" },
    ];

    items.push({ label: toggleLabel, value: "toggle", color: toggleColor });

    items.push({ label: "Re-authenticate", value: "retry-auth", color: "cyan" });

    items.push({ label: "Delete this account", value: "delete", color: "red" });

    const result = await select(items, {
      message: "Account options",
      subtitle: label,
    });

    if (result === "delete") {
      const confirmed = await confirm(`Delete ${label}?`);
      if (!confirmed) continue;
    }

    return { action: result ?? "cancel", account };
  }
}

function getUsageColor(utilization: number): string {
  if (utilization >= 90) return ANSI.red;
  if (utilization >= 60) return ANSI.yellow;
  return ANSI.green;
}

function createProgressBar(utilization: number, width = 20): string {
  const filled = Math.round((utilization / 100) * width);
  const empty = width - filled;
  const color = getUsageColor(utilization);
  return `${color}${"█".repeat(filled)}${ANSI.reset}${"░".repeat(empty)} ${color}${Math.round(utilization)}% used${ANSI.reset}`;
}

function formatResetTime(resetAt: string | null): string {
  if (!resetAt) return "";
  const date = new Date(resetAt);
  const now = new Date();
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const timeStr = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit", hour12: true });

  const isSameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();

  if (isSameDay) {
    return ` (resets ${timeStr}, ${tz})`;
  }
  const dateStr = date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return ` (resets ${dateStr} ${timeStr}, ${tz})`;
}

function printUsageEntry(name: string, entry: { utilization: number; resets_at: string | null } | null, isLast: boolean): void {
  const connector = isLast ? "└─" : "├─";
  if (!entry) {
    console.log(`     ${connector} ${name.padEnd(16)} no data`);
    return;
  }
  const bar = createProgressBar(entry.utilization);
  const reset = formatResetTime(entry.resets_at);
  console.log(`     ${connector} ${name.padEnd(16)} ${bar}${reset}`);
}

export function printQuotaReport(account: ManagedAccount, usage: UsageLimits): void {
  const label = getAccountLabel(account);
  const status = getAccountStatus(account);
  const badge = STATUS_BADGE[status];
  const planLabel = getPlanLabel(account) || "Free";

  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${label} ${badge}`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  if (account.email) {
    console.log(`  📧 ${account.email}`);
  }
  console.log(`  📋 ${planLabel}`);

  console.log(`\n  └─ Claude Quota`);
  printUsageEntry("Current session", usage.five_hour, false);
  printUsageEntry("Current week", usage.seven_day, !usage.seven_day_sonnet);
  if (usage.seven_day_sonnet) {
    printUsageEntry("Sonnet only", usage.seven_day_sonnet, true);
  }
  console.log("");
}

const STRATEGY_DESCRIPTIONS: Record<AccountSelectionStrategy, string> = {
  "sticky": "Same account until rate-limited",
  "round-robin": "Rotate every request",
  "hybrid": "Score-based (usage + health)",
};

export async function showStrategySelect(current: AccountSelectionStrategy): Promise<AccountSelectionStrategy | null> {
  const strategies: AccountSelectionStrategy[] = ["sticky", "round-robin", "hybrid"];

  const items: MenuItem<AccountSelectionStrategy>[] = strategies.map((s) => ({
    label: `${s}${s === current ? " (current)" : ""}`,
    hint: STRATEGY_DESCRIPTIONS[s],
    value: s,
  }));

  return select(items, {
    message: "Load Balancing Strategy",
    subtitle: `Current: ${current}`,
  });
}

export function printQuotaError(account: ManagedAccount, error: string): void {
  const label = getAccountLabel(account);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${label}`);
  if (account.email) {
    console.log(`  📧 ${account.email}`);
  }
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`  ${ANSI.red}Error: ${error}${ANSI.reset}\n`);
}
