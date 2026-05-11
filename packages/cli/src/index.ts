import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  MemoryAccountStore,
  SQLiteRequestLogStore,
  SQLiteAccountStore,
  SQLiteStickySessionStore,
  StickyAccountPool,
  listBlockedAccounts,
  listExpiredRateLimitAccounts,
  listFailedAccounts,
  listRateLimitedAccounts,
  listReadyAccounts,
  summarizeAccountStatus,
  type AccountExecutionTraceEvent,
  type AccountRecord,
  type AccountStore,
  type ProviderId,
  type RequestLogStore,
  type StickySessionRegistry,
} from "@kyoli-gam/core";
import {
  captureClaudeCodeWireRequest,
  checkClaudeCodeTemplateDrift,
  createClaudeCodeProvider,
  detectClaudeCodeOAuthConfig,
  findClaudeCodeBinary,
  getClaudeCodeTemplateMetadata,
  probeClaudeVersion,
  type ClaudeCodeCapturedRequest,
  loadClaudeCodeIdentity,
  refreshClaudeCodeAccountMetadata,
  refreshClaudeCodeOAuthToken,
  startClaudeCodeOAuthLogin,
} from "@kyoli-gam/provider-claude-code";
import {
  createCodexChatGPTProvider,
  startCodexOAuthLogin,
} from "@kyoli-gam/provider-codex-chatgpt";
import { createGateway, serveGateway } from "@kyoli-gam/gateway";
import {
  createDefaultCliConfig,
  initCliConfig,
  loadCliConfig,
  resolveConfigPath,
} from "./config";
import {
  runCodexE2EDoctor,
  runCodexFileSmokeDoctor,
  runCodexLoadDoctor,
  runCodexSmokeDoctor,
} from "./codex-smoke";
import {
  importOpenCodeAccounts,
  type OpenCodeImportProvider,
  type OpenCodeImportResult,
} from "./opencode-import";
import {
  installOpenCode,
  restoreOpenCode,
  runInstalledOpenCode,
  type OpenCodeInstallResult,
  type OpenCodeRestoreResult,
} from "./opencode-install";
import {
  openOAuthBrowser,
  readOAuthBrowserMode,
  shouldOpenOAuthBrowser,
  type OAuthBrowserMode,
} from "./oauth-browser";
import {
  createPoolStatus,
  formatPoolBanner,
  formatPoolDoctorDetail,
} from "./pool-status";

const command = process.argv[2] ?? "help";
const cliConfig = await loadCliConfig(process.argv, process.env);

if (command === "serve") {
  warnIfAdminTokenMissingForPublicHost(cliConfig);

  const accountStore = new SQLiteAccountStore(cliConfig.databasePath);
  const stickySessionStore = new SQLiteStickySessionStore(cliConfig.databasePath);
  const requestLogStore = new SQLiteRequestLogStore(cliConfig.databasePath);
  const accountPool = new StickyAccountPool(accountStore, {
    strategy: cliConfig.accountSelectionStrategy,
    softQuotaThresholdPercent: cliConfig.softQuotaThresholdPercent,
    planWeights: cliConfig.planWeights,
    stickySessionStore,
  });

  const server = await serveGateway({
    config: {
      host: cliConfig.host,
      port: cliConfig.port,
    },
    accounts: accountStore,
    stickySessions: accountPool,
    requestLogs: requestLogStore,
    providers: [
      createCodexChatGPTProvider({
        accounts: accountPool,
        onTrace: createServeTraceLogger(cliConfig, requestLogStore),
      }),
      createClaudeCodeProvider({
        accounts: accountPool,
        allowLiveMessages: readBooleanEnv("KYOLI_CLAUDE_ALLOW_LIVE_MESSAGES"),
        onTrace: createServeTraceLogger(cliConfig, requestLogStore),
        usageRefreshIntervalMs: cliConfig.usageRefreshIntervalMs,
      }),
    ],
    adminToken: cliConfig.adminToken,
    maxConcurrentRequests: cliConfig.maxConcurrentRequests,
  });

  console.log(`kyoli-gam gateway listening on http://${server.hostname}:${server.port}`);
  printPoolBanner(await accountStore.list(), {
    strategy: cliConfig.accountSelectionStrategy ?? "sticky",
    stickySessions: stickySessionStore,
    requestLogs: requestLogStore,
  });
} else if (command === "login" && process.argv[3] === "codex") {
  const accountStore = new SQLiteAccountStore(cliConfig.databasePath);
  const login = await startCodexOAuthLogin();
  const browserMode = readOAuthBrowserMode(process.argv);

  printOAuthLoginInstructions("ChatGPT/Codex", login.authorizeUrl, browserMode);

  try {
    const tokens = await login.waitForTokens;
    const account = await accountStore.create({
      provider: "codex",
      kind: "oauth",
      name: tokens.email ? `Codex ${tokens.email}` : "Codex OAuth account",
      credentials: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        accountId: tokens.accountId,
      },
      metadata: {
        email: tokens.email,
        accountId: tokens.accountId,
      },
    });

    console.log(`Codex account saved: ${account.name} (${account.id})`);
  } finally {
    login.stop();
  }
} else if (command === "login" && process.argv[3] === "claude") {
  const accountStore = new SQLiteAccountStore(cliConfig.databasePath);
  const login = await startClaudeCodeOAuthLogin();
  const browserMode = readOAuthBrowserMode(process.argv);

  printOAuthLoginInstructions("Claude Code", login.authorizeUrl, browserMode);
  console.log(`OAuth config source: ${login.oauthConfig.source}`);

  try {
    const tokens = await login.waitForTokens;
    const identity = loadClaudeCodeIdentity();
    const account = await accountStore.create({
      provider: "claude-code",
      kind: "oauth",
      name: tokens.email ? `Claude ${tokens.email}` : "Claude Code OAuth account",
      credentials: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        accountId: tokens.accountId,
      },
      metadata: {
        email: tokens.email,
        accountId: tokens.accountId,
        deviceId: identity.deviceId,
        planTier: tokens.planTier,
        cachedUsage: tokens.cachedUsage,
        cachedUsageAt: tokens.cachedUsageAt,
        oauthConfigSource: tokens.oauthConfigSource,
      },
    });

    console.log(`Claude Code account saved: ${account.name} (${account.id})`);
  } finally {
    login.stop();
  }
} else if (command === "accounts") {
  await handleAccountsCommand(process.argv, new SQLiteAccountStore(cliConfig.databasePath), {
    stickySessions: new SQLiteStickySessionStore(cliConfig.databasePath),
    requestLogs: new SQLiteRequestLogStore(cliConfig.databasePath),
  });
} else if (command === "install") {
  await handleInstallCommand(process.argv, cliConfig);
} else if (command === "restore") {
  await handleRestoreCommand(process.argv);
} else if (command === "config") {
  await handleConfigCommand(process.argv, cliConfig);
} else if (command === "doctor") {
  await handleDoctorCommand(process.argv);
} else {
  printHelp();
}

async function handleInstallCommand(
  argv: string[],
  config: Awaited<ReturnType<typeof loadCliConfig>>,
): Promise<void> {
  const target = argv[3];
  if (target !== "opencode") {
    throw new Error("Supported install target: opencode");
  }

  const result = await installOpenCode(config, {
    configDir: readStringFlag(argv, "--config-dir"),
    dryRun: argv.includes("--dry-run"),
    force: argv.includes("--force"),
    includeModels: !argv.includes("--no-models"),
    allModels: argv.includes("--all-models"),
    preserveOpenAI: argv.includes("--preserve-openai"),
  });

  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printOpenCodeInstallResult(result);
}

async function handleRestoreCommand(argv: string[]): Promise<void> {
  const target = argv[3];
  if (target !== "opencode") {
    throw new Error("Supported restore target: opencode");
  }

  const result = await restoreOpenCode({
    configDir: readStringFlag(argv, "--config-dir"),
    backupPath: readStringFlag(argv, "--backup"),
    dryRun: argv.includes("--dry-run"),
  });

  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  printOpenCodeRestoreResult(result);
}

async function handleDoctorCommand(argv: string[]): Promise<void> {
  const subcommand = argv[3] ?? "all";

  if (subcommand === "all") {
    const accountStore = new SQLiteAccountStore(cliConfig.databasePath);
    const stickySessionStore = new SQLiteStickySessionStore(cliConfig.databasePath);
    const requestLogStore = new SQLiteRequestLogStore(cliConfig.databasePath);
    const pool = withDoctorName(await runPoolDoctor(
      accountStore,
      cliConfig,
      {
        stickySessions: stickySessionStore,
        requestLogs: requestLogStore,
      },
    ), "pool");
    const codex = withDoctorName(await runCodexSmokeDoctor(
      accountStore,
      cliConfig,
      {
        route: readCodexSmokeRouteFlag(argv),
        model: readStringFlag(argv, "--model"),
        expectedText: readStringFlag(argv, "--expect"),
        sessionId: readStringFlag(argv, "--session-id"),
        timeoutMs: readOptionalNumber(readStringFlag(argv, "--timeout-ms")),
      },
    ), "codex");
    const claude = withDoctorName(await runClaudeFingerprintDoctor(), "claude");
    const install = await runOpenCodeInstallDoctor(argv, cliConfig);
    const report = combineDoctorReports("doctor", [pool, codex, claude, install]);
    printMaybeJsonDoctorReport(report, argv);
    setDoctorExitCode(report);
    return;
  }

  if (subcommand === "pool") {
    const report = await runPoolDoctor(
      new SQLiteAccountStore(cliConfig.databasePath),
      cliConfig,
      {
        stickySessions: new SQLiteStickySessionStore(cliConfig.databasePath),
        requestLogs: new SQLiteRequestLogStore(cliConfig.databasePath),
      },
    );
    printMaybeJsonDoctorReport(withDoctorName(report, "pool"), argv);
    setDoctorExitCode(report);
    return;
  }

  if (subcommand === "codex") {
    if (argv.includes("--file")) {
      runAndPrintDoctorReport(
        withDoctorName(await runCodexFileSmokeDoctor(
          new SQLiteAccountStore(cliConfig.databasePath),
          cliConfig,
          {
            fileName: readStringFlag(argv, "--file-name"),
            fileContent: readStringFlag(argv, "--content"),
            sessionId: readStringFlag(argv, "--session-id"),
            timeoutMs: readOptionalNumber(readStringFlag(argv, "--timeout-ms")),
          },
        ), "codex/file"),
        argv,
      );
      return;
    }

    if (argv.includes("--e2e")) {
      runAndPrintDoctorReport(
        withDoctorName(await runCodexE2EDoctor(
          new SQLiteAccountStore(cliConfig.databasePath),
          cliConfig,
          {
            model: readStringFlag(argv, "--model"),
            expectedText: readStringFlag(argv, "--expect"),
            sessionId: readStringFlag(argv, "--session-id"),
            timeoutMs: readOptionalNumber(readStringFlag(argv, "--timeout-ms")),
            port: readOptionalNumber(readStringFlag(argv, "--port")),
            includeOpenCode: argv.includes("--opencode"),
            openCodeCommand: readStringFlag(argv, "--opencode-bin"),
            includeCodexCli: argv.includes("--codex-cli"),
            codexCliCommand: readStringFlag(argv, "--codex-bin"),
            keepTemp: argv.includes("--keep-temp"),
          },
        ), "codex/e2e"),
        argv,
      );
      return;
    }

    if (argv.includes("--load")) {
      runAndPrintDoctorReport(
        withDoctorName(await runCodexLoadDoctor(
          new SQLiteAccountStore(cliConfig.databasePath),
          cliConfig,
          {
            route: readCodexSmokeRouteFlag(argv),
            model: readStringFlag(argv, "--model"),
            requests: readOptionalNumber(readStringFlag(argv, "--requests")),
            concurrency: readOptionalNumber(readStringFlag(argv, "--concurrency")),
            timeoutMs: readOptionalNumber(readStringFlag(argv, "--timeout-ms")),
          },
        ), "codex/load"),
        argv,
      );
      return;
    }

    const report = await runCodexSmokeDoctor(
      new SQLiteAccountStore(cliConfig.databasePath),
      cliConfig,
      {
        route: readCodexSmokeRouteFlag(argv),
        model: readStringFlag(argv, "--model"),
        expectedText: readStringFlag(argv, "--expect"),
        sessionId: readStringFlag(argv, "--session-id"),
        timeoutMs: readOptionalNumber(readStringFlag(argv, "--timeout-ms")),
      },
    );
    printMaybeJsonDoctorReport(withDoctorName(report, "codex"), argv);
    setDoctorExitCode(report);
    return;
  }

  if (subcommand === "claude") {
    let report: DoctorReport;
    if (argv.includes("--binary")) {
      report = withDoctorName(await runClaudeBinaryDoctor(), "claude/binary");
    } else if (argv.includes("--template")) {
      report = withDoctorName(await runClaudeTemplateDriftDoctor({
        timeoutMs: readOptionalNumber(readStringFlag(argv, "--timeout-ms")),
      }), "claude/template");
    } else if (argv.includes("--wire")) {
      report = withDoctorName(await runClaudeWireCompareDoctor({
        timeoutMs: readOptionalNumber(readStringFlag(argv, "--timeout-ms")),
      }), "claude/wire");
    } else if (argv.includes("--smoke")) {
      report = withDoctorName(await runClaudeSmokeDoctor(
        new SQLiteAccountStore(cliConfig.databasePath),
        cliConfig,
        {
          model: readStringFlag(argv, "--model"),
        },
      ), "claude/smoke");
    } else {
      report = withDoctorName(await runClaudeFingerprintDoctor(), "claude");
    }
    printMaybeJsonDoctorReport(report, argv);
    setDoctorExitCode(report);
    return;
  }

  if (subcommand === "opencode") {
    const report = await runOpenCodeInstallDoctor(argv, cliConfig);
    printMaybeJsonDoctorReport(report, argv);
    setDoctorExitCode(report);
    return;
  }

  throw new Error("Supported doctor targets: pool, codex, claude, opencode.");
}

async function handleConfigCommand(
  argv: string[],
  config: Awaited<ReturnType<typeof loadCliConfig>>,
): Promise<void> {
  const subcommand = argv[3] ?? "show";
  const configPath = resolveConfigPath(argv, process.env);

  if (subcommand === "path") {
    console.log(configPath);
    return;
  }

  if (subcommand === "show") {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (subcommand === "default") {
    console.log(JSON.stringify(createDefaultCliConfig(), null, 2));
    return;
  }

  if (subcommand === "init") {
    const result = await initCliConfig(configPath, { force: argv.includes("--force") });
    if (result === "exists") {
      console.log(`Config already exists: ${configPath}`);
      console.log("Use --force to overwrite it.");
      return;
    }

    console.log(`${result === "created" ? "Created" : "Overwrote"} config: ${configPath}`);
    return;
  }

  printHelp();
}

async function handleAccountsCommand(
  argv: string[],
  store: AccountStore,
  observability: {
    stickySessions?: SQLiteStickySessionStore;
    requestLogs?: RequestLogStore;
  } = {},
): Promise<void> {
  const subcommand = argv[3] ?? "list";

  if (subcommand === "import") {
    const source = argv[4];
    if (source !== "opencode") {
      throw new Error("Supported account import source: opencode");
    }

    const result = await importOpenCodeAccounts(store, {
      dryRun: argv.includes("--dry-run"),
      sync: argv.includes("--sync"),
      provider: readImportProviderFlag(argv),
      configDir: readStringFlag(argv, "--config-dir"),
    });
    printOpenCodeImportResult(result, {
      dryRun: argv.includes("--dry-run"),
      sync: argv.includes("--sync"),
    });
    return;
  }

  if (subcommand === "list") {
    const provider = readProviderArg(argv[4]);
    const accounts = provider
      ? await store.listByProvider(provider)
      : await store.list();
    printAccounts(accounts);
    return;
  }

  if (subcommand === "status") {
    const provider = readOptionalProviderArg(argv[4]);
    const accounts = provider
      ? await store.listByProvider(provider)
      : await store.list();
    printAccountStatus(accounts, {
      json: argv.includes("--json"),
      stickySessions: observability.stickySessions,
      requestLogs: observability.requestLogs,
    });
    return;
  }

  if (subcommand === "reset-expired") {
    const provider = readOptionalProviderArg(argv[4]);
    const accounts = provider
      ? await store.listByProvider(provider)
      : await store.list();
    const expired = listExpiredRateLimitAccounts(accounts);
    if (expired.length === 0) {
      console.log("No expired rate-limit state found.");
      return;
    }

    const reset = [];
    for (const account of expired) {
      const updated = await store.resetState(account.id, { enable: argv.includes("--enable") });
      if (updated) reset.push(updated);
    }

    console.log(`Reset expired rate-limit state for ${reset.length} account${reset.length === 1 ? "" : "s"}.`);
    printAccounts(reset);
    return;
  }

  if (subcommand === "show") {
    const account = await requireAccount(store, argv[4]);
    printAccountDetails(account);
    return;
  }

  if (subcommand === "enable" || subcommand === "disable" || subcommand === "pause" || subcommand === "reactivate") {
    const account = await requireAccount(store, argv[4]);
    if (subcommand === "reactivate") {
      const updated = await store.resetState(account.id, { enable: true });
      if (!updated) throw new Error(`Account not found: ${account.id}`);
      console.log(`Reactivated account: ${updated.name} (${updated.id})`);
      printAccountDetails(updated);
      return;
    }

    const enable = subcommand === "enable";
    const updated = await store.update(account.id, { enabled: enable });
    const action = enable ? "Enabled" : subcommand === "pause" ? "Paused" : "Disabled";
    console.log(`${action} account: ${updated?.name ?? account.name} (${account.id})`);
    return;
  }

  if (subcommand === "delete") {
    const account = await requireAccount(store, argv[4]);
    const deleted = await store.delete(account.id);
    if (!deleted) throw new Error(`Account not found: ${account.id}`);
    console.log(`Deleted account: ${account.name} (${account.id})`);
    return;
  }

  if (subcommand === "refresh") {
    const account = await requireAccount(store, argv[4]);
    const refreshed = await refreshAccountMetadata(store, account);
    console.log(`Refreshed account: ${refreshed.name} (${refreshed.id})`);
    printAccountDetails(refreshed);
    return;
  }

  if (subcommand === "reset") {
    const account = await requireAccount(store, argv[4]);
    const reset = await store.resetState(account.id, { enable: argv.includes("--enable") });
    if (!reset) throw new Error(`Account not found: ${account.id}`);
    console.log(`Reset account state: ${reset.name} (${reset.id})`);
    printAccountDetails(reset);
    return;
  }

  printHelp();
}

function printOpenCodeImportResult(
  result: OpenCodeImportResult,
  options: { dryRun: boolean; sync: boolean },
): void {
  const action = options.dryRun ? "creatable" : "created";
  const mode = options.sync ? "sync" : "import";
  console.log(
    `OpenCode ${mode} ${options.dryRun ? "dry-run" : "done"}: ${result.created} ${action}, ${result.updated} updated, ${result.unchanged} unchanged, ${result.duplicates} duplicates, ${result.skipped} skipped`,
  );

  const rows = result.sources.map((source) => ({
    provider: source.provider,
    total: String(source.total),
    eligible: String(source.eligible),
    [action]: String(source.created),
    updated: String(source.updated),
    unchanged: String(source.unchanged),
    duplicates: String(source.duplicates),
    skipped: String(source.skipped),
    path: source.path,
  }));
  if (rows.length > 0) {
    printTable(rows, ["provider", "total", "eligible", action, "updated", "unchanged", "duplicates", "skipped", "path"]);
  }
}

function printOAuthLoginInstructions(
  providerLabel: string,
  authorizeUrl: string,
  browserMode: OAuthBrowserMode,
): void {
  if (shouldOpenOAuthBrowser(browserMode)) {
    openOAuthBrowser(authorizeUrl);
    console.log(`Attempting to open your browser to sign in with ${providerLabel}.`);
    console.log("Paste this URL into your browser if it does not open automatically:");
  } else if (browserMode === "headless") {
    console.log(`Headless login requested for ${providerLabel}. Open this URL in a browser on this machine:`);
  } else {
    console.log(`Manual login requested for ${providerLabel}. Open this URL in your browser:`);
  }
  console.log(authorizeUrl);
}

function printOpenCodeInstallResult(result: OpenCodeInstallResult): void {
  console.log(`OpenCode install ${result.dryRun ? "dry-run" : "done"}: ${result.changed ? "changes prepared" : "already up to date"}`);
  console.log(`Config: ${result.configPath}`);
  console.log(`Server: ${result.baseUrl}`);
  console.log(`Models: ${result.modelSource}`);
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`);

  printTable(
    result.providers.map((provider) => ({
      provider: provider.id,
      baseURL: provider.baseURL,
      models: String(provider.modelCount),
    })),
    ["provider", "baseURL", "models"],
  );

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }

  if (result.dryRun) {
    console.log("\nNo files were written. Re-run without --dry-run to apply.");
  }
}

function printOpenCodeRestoreResult(result: OpenCodeRestoreResult): void {
  console.log(`OpenCode restore ${result.dryRun ? "dry-run" : "done"}: ${result.restored ? "backup selected" : "no backup restored"}`);
  console.log(`Config: ${result.configPath}`);
  if (result.backupPath) console.log(`Backup: ${result.backupPath}`);

  if (result.warnings.length > 0) {
    console.log("\nWarnings:");
    for (const warning of result.warnings) console.log(`- ${warning}`);
  }

  if (result.dryRun) {
    console.log("\nNo files were written. Re-run without --dry-run to restore.");
  }
}

async function requireAccount(store: AccountStore, id: string | undefined): Promise<AccountRecord> {
  if (!id) throw new Error("Account id is required.");

  const account = await store.get(id);
  if (!account) throw new Error(`Account not found: ${id}`);
  return account;
}

async function refreshAccountMetadata(
  store: AccountStore,
  account: AccountRecord,
): Promise<AccountRecord> {
  if (account.provider !== "claude-code") {
    throw new Error("Only claude-code accounts support metadata refresh for now.");
  }

  const refreshToken = readString(account.credentials.refreshToken);
  let accessToken = readString(account.credentials.accessToken);
  let credentials = account.credentials;
  let metadata = account.metadata;

  if ((!accessToken || isExpired(account.credentials.expiresAt)) && refreshToken) {
    const refreshed = await refreshClaudeCodeOAuthToken(refreshToken);
    accessToken = refreshed.accessToken;
    credentials = {
      ...credentials,
      accessToken,
      refreshToken: refreshed.refreshToken ?? refreshToken,
      expiresAt: refreshed.expiresAt,
      accountId: refreshed.accountId ?? credentials.accountId,
    };
    metadata = {
      ...metadata,
      email: refreshed.email ?? metadata.email,
      accountId: refreshed.accountId ?? metadata.accountId,
    };
  }

  if (!accessToken) {
    throw new Error("Account has no access token and cannot be refreshed.");
  }

  const accountMetadata = await refreshClaudeCodeAccountMetadata(accessToken);
  const updated = await store.update(account.id, {
    credentials,
    metadata: {
      ...metadata,
      email: accountMetadata.email ?? metadata.email,
      planTier: accountMetadata.planTier ?? metadata.planTier,
      cachedUsage: accountMetadata.cachedUsage ?? metadata.cachedUsage,
      cachedUsageAt: accountMetadata.cachedUsageAt ?? metadata.cachedUsageAt,
    },
  });
  if (!updated) throw new Error(`Account not found: ${account.id}`);
  return updated;
}

function printAccounts(accounts: AccountRecord[]): void {
  if (accounts.length === 0) {
    console.log("No accounts found.");
    return;
  }

  const rows = accounts.map((account) => ({
    id: account.id,
    provider: account.provider,
    state: formatAccountState(account),
    plan: readString(account.metadata.planTier) ?? "-",
    usage: formatUsage(account.metadata.cachedUsage),
    name: account.name,
    lastUsed: formatRelativeTime(account.lastUsedAt),
  }));

  printTable(rows, ["id", "provider", "state", "plan", "usage", "lastUsed", "name"]);
}

function printAccountStatus(
  accounts: AccountRecord[],
  options: {
    json?: boolean;
    stickySessions?: StickySessionRegistry;
    requestLogs?: RequestLogStore;
  } = {},
): void {
  if (accounts.length === 0) {
    console.log(options.json ? JSON.stringify(createAccountStatusPayload(accounts), null, 2) : "No accounts found.");
    return;
  }

  const payload = createAccountStatusPayload(accounts, {
    stickySessions: options.stickySessions,
    requestLogs: options.requestLogs,
  });
  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const summaryRows = payload.summary.map((summary) => ({
    provider: summary.provider,
    total: String(summary.total),
    ready: String(summary.ready),
    rate_limited: String(summary.rate_limited),
    auth_cooldown: String(summary.auth_cooldown),
    disabled: String(summary.disabled),
    reauth_required: String(summary.reauth_required),
    failed: String(summary.failed),
    next_reset: summary.next_reset_at ? formatRelativeFuture(summary.next_reset_at) : "-",
    next_auth_retry: summary.next_auth_retry_at ? formatRelativeFuture(summary.next_auth_retry_at) : "-",
  }));
  printTable(summaryRows, [
    "provider",
    "total",
    "ready",
    "rate_limited",
    "auth_cooldown",
    "disabled",
    "reauth_required",
    "failed",
    "next_reset",
    "next_auth_retry",
  ]);

  const readyRows = payload.ready.map((account) => ({
    id: account.id,
    provider: account.provider,
    plan: account.plan_tier ?? "-",
    failures: String(account.failure_count),
    last_used: formatRelativeTime(account.last_used_at),
    name: account.name,
  }));
  if (readyRows.length > 0) {
    console.log("");
    console.log("Ready accounts:");
    printTable(readyRows, ["id", "provider", "plan", "failures", "last_used", "name"]);
  }

  const rateLimitedRows = payload.rate_limited.map((account) => ({
    id: account.id,
    provider: account.provider,
    reset_in: account.reset_in,
    reset_at: account.reset_at,
    failures: String(account.failure_count),
    last_error: formatRelativeTime(account.last_error_at),
    name: account.name,
  }));
  if (rateLimitedRows.length > 0) {
    console.log("");
    console.log("Rate-limited accounts:");
    printTable(rateLimitedRows, ["id", "provider", "reset_in", "failures", "last_error", "reset_at", "name"]);
  }

  const blockedRows = payload.blocked.map((account) => ({
    id: account.id,
    provider: account.provider,
    state: account.state,
    reason: truncate(account.reason, 48),
    retry_in: account.retry_at ? formatRelativeFuture(account.retry_at) : "-",
    name: account.name,
  }));
  if (blockedRows.length > 0) {
    console.log("");
    console.log("Blocked accounts:");
    printTable(blockedRows, ["id", "provider", "state", "reason", "retry_in", "name"]);
  }

  const failedRows = payload.failed.map((account) => ({
    id: account.id,
    provider: account.provider,
    state: account.state,
    failures: String(account.failure_count),
    last_error: formatRelativeTime(account.last_error_at),
    retry_in: account.auth_retry_at
      ? formatRelativeFuture(account.auth_retry_at)
      : account.reset_at
        ? formatRelativeFuture(account.reset_at)
        : "-",
    name: account.name,
  }));
  if (failedRows.length > 0) {
    console.log("");
    console.log("Recent failures:");
    printTable(failedRows, ["id", "provider", "state", "failures", "last_error", "retry_in", "name"]);
  }

  if (payload.observability.length > 0) {
    console.log("");
    console.log("Routing/traffic:");
    const rows = payload.observability.map((row) => ({
      provider: row.provider,
      sticky: String(row.sticky_sessions.total),
      prompt_cache: String(row.sticky_sessions.prompt_cache),
      codex_session: String(row.sticky_sessions.codex_session),
      responses: String(row.request_logs.responses),
      rate_limited: String(row.request_logs.rate_limited_responses),
      latest: row.request_logs.latest_at ? formatRelativeTime(row.request_logs.latest_at) : "-",
    }));
    printTable(rows, ["provider", "sticky", "prompt_cache", "codex_session", "responses", "rate_limited", "latest"]);
  }
}

function printPoolBanner(
  accounts: AccountRecord[],
  options: {
    strategy: string;
    stickySessions?: StickySessionRegistry;
    requestLogs?: RequestLogStore;
  },
): void {
  const status = createPoolStatus({
    accounts,
    strategy: options.strategy,
    stickySessions: options.stickySessions,
    requestLogs: options.requestLogs,
  });
  for (const line of formatPoolBanner(status)) {
    console.log(line);
  }
}

function createAccountStatusPayload(
  accounts: AccountRecord[],
  options: {
    stickySessions?: StickySessionRegistry;
    requestLogs?: RequestLogStore;
  } = {},
) {
  return {
    summary: summarizeAccountStatus(accounts).map(toPublicAccountStatusSummary),
    ready: listReadyAccounts(accounts).map(toPublicReadyAccount),
    rate_limited: listRateLimitedAccounts(accounts).map(toPublicRateLimitedAccount),
    blocked: listBlockedAccounts(accounts).map(toPublicBlockedAccount),
    failed: listFailedAccounts(accounts).map(toPublicFailedAccount),
    expired_rate_limits: listExpiredRateLimitAccounts(accounts).map((account) => ({
      id: account.id,
      provider: account.provider,
      reset_at: account.rateLimitResetAt,
      failure_count: account.failureCount,
      name: account.name,
    })),
    observability: createAccountObservabilityRows(accounts, options),
  };
}

function toPublicAccountStatusSummary(row: ReturnType<typeof summarizeAccountStatus>[number]) {
  return {
    provider: row.provider,
    total: row.total,
    ready: row.ready,
    rate_limited: row.rateLimited,
    auth_cooldown: row.authCooldown,
    disabled: row.disabled,
    reauth_required: row.reauthRequired,
    failed: row.failed,
    next_reset_at: row.nextResetAt,
    next_auth_retry_at: row.nextAuthRetryAt,
  };
}

function toPublicReadyAccount(row: ReturnType<typeof listReadyAccounts>[number]) {
  return {
    id: row.id,
    provider: row.provider,
    name: row.name,
    plan_tier: row.planTier,
    last_used_at: row.lastUsedAt,
    failure_count: row.failureCount,
  };
}

function toPublicRateLimitedAccount(row: ReturnType<typeof listRateLimitedAccounts>[number]) {
  return {
    id: row.id,
    provider: row.provider,
    reset_at: row.resetAt,
    reset_in: row.resetIn,
    failure_count: row.failureCount,
    last_error_at: row.lastErrorAt,
    name: row.name,
  };
}

function toPublicBlockedAccount(row: ReturnType<typeof listBlockedAccounts>[number]) {
  return {
    id: row.id,
    provider: row.provider,
    state: row.state,
    reason: row.reason,
    name: row.name,
    retry_at: row.retryAt,
    consecutive_auth_failures: row.consecutiveAuthFailures,
  };
}

function toPublicFailedAccount(row: ReturnType<typeof listFailedAccounts>[number]) {
  return {
    id: row.id,
    provider: row.provider,
    state: row.state,
    failure_count: row.failureCount,
    last_error_at: row.lastErrorAt,
    reset_at: row.resetAt,
    auth_retry_at: row.authRetryAt,
    name: row.name,
  };
}

function createAccountObservabilityRows(
  accounts: AccountRecord[],
  options: {
    stickySessions?: StickySessionRegistry;
    requestLogs?: RequestLogStore;
  },
) {
  const providers = [...new Set(accounts.map((account) => account.provider))].sort();
  const stickySessions = options.stickySessions?.listStickySessions() ?? [];
  const requestLogs = options.requestLogs?.listRequestLogs({ limit: 500 }) ?? [];

  return providers.map((provider) => {
    const providerSessions = stickySessions.filter((session) => session.provider === provider);
    const providerLogs = requestLogs.filter((log) => log.provider === provider);
    const responseLogs = providerLogs.filter((log) => log.eventType === "response");
    return {
      provider,
      sticky_sessions: {
        total: providerSessions.length,
        prompt_cache: providerSessions.filter((session) => session.kind === "prompt_cache").length,
        codex_session: providerSessions.filter((session) => session.kind === "codex_session").length,
      },
      request_logs: {
        events: providerLogs.length,
        responses: responseLogs.length,
        rate_limited_responses: responseLogs.filter((log) => log.status === 429).length,
        latest_at: providerLogs[0]?.createdAt,
      },
    };
  });
}

function printAccountDetails(account: AccountRecord): void {
  const publicDetails = {
    id: account.id,
    provider: account.provider,
    kind: account.kind,
    name: account.name,
    enabled: account.enabled,
    state: formatAccountState(account),
    credential_keys: Object.keys(account.credentials),
    metadata: account.metadata,
    failure_count: account.failureCount,
    last_used_at: account.lastUsedAt,
    last_error_at: account.lastErrorAt,
    rate_limit_reset_at: account.rateLimitResetAt,
    auth_cooldown_until: account.authCooldownUntil,
    consecutive_auth_failures: account.consecutiveAuthFailures,
    reauth_required_reason: account.reauthRequiredReason,
    created_at: account.createdAt,
    updated_at: account.updatedAt,
  };
  console.log(JSON.stringify(publicDetails, null, 2));
}

interface DoctorCheck {
  name: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

interface DoctorReport {
  name: string;
  summary: {
    pass: number;
    warn: number;
    fail: number;
  };
  checks: DoctorCheck[];
}

async function runPoolDoctor(
  store: AccountStore,
  config: Awaited<ReturnType<typeof loadCliConfig>>,
  options: {
    stickySessions?: StickySessionRegistry;
    requestLogs?: RequestLogStore;
  } = {},
): Promise<DoctorReport> {
  const accounts = await store.list();
  const status = createPoolStatus({
    accounts,
    strategy: config.accountSelectionStrategy ?? "sticky",
    stickySessions: options.stickySessions,
    requestLogs: options.requestLogs,
  });

  const checks: DoctorCheck[] = [
    warnCheck("account inventory", status.total > 0, formatPoolDoctorDetail(status)),
    warnCheck(
      "ready accounts",
      status.ready > 0,
      status.total === 0
        ? "No accounts available yet"
        : `${status.ready}/${status.total} account(s) ready`,
    ),
    warnCheck(
      "pool mode",
      status.total !== 1,
      status.total === 0
        ? "No accounts loaded yet"
        : status.total === 1
        ? "single-account mode; add another account for failover and load balancing"
        : `${status.strategy} across ${status.total} account(s)`,
    ),
    warnCheck(
      "blocked accounts",
      status.disabled + status.reauthRequired + status.authCooldown === 0,
      `disabled=${status.disabled} reauth_required=${status.reauthRequired} auth_cooldown=${status.authCooldown}`,
    ),
  ];

  for (const provider of status.providers) {
    checks.push(
      warnCheck(
        `${provider.provider} ready`,
        provider.ready > 0,
        `${provider.ready}/${provider.total} ready; rate_limited=${provider.rateLimited} reauth_required=${provider.reauthRequired} auth_cooldown=${provider.authCooldown}`,
      ),
    );
  }

  checks.push(warnCheck(
    "sticky sessions",
    status.stickySessions > 0 || status.responses === 0,
    `${status.stickySessions} sticky session(s), ${status.responses} response event(s)`,
  ));

  return {
    name: "pool",
    summary: summarizeChecks(checks),
    checks,
  };
}

async function runClaudeBinaryDoctor(): Promise<DoctorReport> {
  const shellPath = findShellClaudeBinary();
  const selectedPath = findClaudeCodeBinary();
  const shellVersion = shellPath ? probeClaudeVersion(shellPath) : undefined;
  const selectedVersion = selectedPath ? probeClaudeVersion(selectedPath) : undefined;
  const template = getClaudeCodeTemplateMetadata();
  const oauthConfig = await detectClaudeCodeOAuthConfig().catch(() => undefined);

  const checks: DoctorCheck[] = [
    check("shell claude", Boolean(shellPath), shellPath ?? "No claude binary found on PATH"),
    check("selected claude", Boolean(selectedPath), selectedPath ?? "Claude Code detector did not find a binary"),
  ];

  if (shellPath && selectedPath) {
    checks.push(
      warnCheck(
        "shell vs selected",
        shellPath === selectedPath,
        `shell=${shellPath} selected=${selectedPath}`,
      ),
    );
  }

  checks.push(
    check("selected version", Boolean(selectedVersion), selectedVersion ?? "Unable to probe selected Claude Code version"),
    warnCheck(
      "bundled template version",
      Boolean(selectedVersion && template.ccVersion && selectedVersion === template.ccVersion),
      `selected=${selectedVersion ?? "unknown"} bundled=${template.ccVersion ?? "unknown"}`,
    ),
    warnCheck(
      "shell version",
      Boolean(!shellPath || !selectedVersion || shellVersion === selectedVersion),
      `shell=${shellVersion ?? "unknown"} selected=${selectedVersion ?? "unknown"}`,
    ),
    warnCheck(
      "x-client-request-id string",
      Boolean(selectedPath && binaryContains(selectedPath, "x-client-request-id")),
      selectedPath ? "selected binary contains x-client-request-id marker" : "selected binary missing",
    ),
    warnCheck(
      "api request id error string",
      Boolean(selectedPath && binaryContains(selectedPath, "API error x-client-request-id=")),
      selectedPath ? "selected binary contains API error request-id marker" : "selected binary missing",
    ),
    warnCheck(
      "oauth config source",
      Boolean(oauthConfig && oauthConfig.source !== "fallback"),
      oauthConfig
        ? `source=${oauthConfig.source}${oauthConfig.ccPath ? ` path=${oauthConfig.ccPath}` : ""}`
        : "OAuth config detection failed",
    ),
  );

  return {
    name: "claude-binary",
    summary: summarizeChecks(checks),
    checks,
  };
}

async function runClaudeFingerprintDoctor(): Promise<DoctorReport> {
  let upstreamUrl = "";
  let upstreamHeaders = new Headers();
  let upstreamBody: Record<string, unknown> = {};

  const store = new MemoryAccountStore();
  await store.create({
    provider: "claude-code",
    kind: "oauth",
    credentials: {
      accessToken: "doctor-access",
      expiresAt: Date.now() + 60 * 60 * 1000,
      refreshToken: "doctor-refresh",
    },
    metadata: {
      accountId: "doctor-account",
      planTier: "pro",
      cachedUsageAt: Date.now(),
    },
  });

  const fetchProbe = (async (input: RequestInfo | URL, init?: RequestInit) => {
    upstreamUrl = String(input);
    upstreamHeaders = new Headers(init?.headers);
    upstreamBody = readRecord(JSON.parse(String(init?.body))) ?? {};
    return new Response(JSON.stringify({ id: "msg_doctor", type: "message" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const provider = createClaudeCodeProvider({
    accounts: new StickyAccountPool(store),
    allowLiveMessages: true,
    baseUrl: "https://doctor.invalid",
    usageRefreshIntervalMs: 0,
    usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
    fetch: fetchProbe,
  });

  await provider.handleRequest({
    request: new Request("http://127.0.0.1:2021/v1/messages", {
      method: "POST",
      headers: {
        "anthropic-beta": "caller-beta,extended-cache-ttl-2025-04-11",
        "anthropic-version": "caller-version",
        "content-type": "application/json",
        "user-agent": "not-claude-code",
        "x-app": "not-cli",
        "x-client-request-id": "caller-request-id",
        "x-stainless-runtime": "browser",
        "x-stainless-timeout": "999",
      },
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4-5",
        max_tokens: 1024,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "doctor ping", cache_control: { type: "ephemeral" } }],
          },
        ],
        temperature: 0.2,
        top_p: 0.9,
        top_k: 10,
      }),
    }),
    route: "/v1/messages",
    sessionKey: "doctor-claude-fingerprint",
    body: {
      model: "anthropic/claude-sonnet-4-5",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "doctor ping", cache_control: { type: "ephemeral" } }],
        },
      ],
      temperature: 0.2,
      top_p: 0.9,
      top_k: 10,
    },
    model: "anthropic/claude-sonnet-4-5",
  });

  const beta = upstreamHeaders.get("anthropic-beta") ?? "";
  const checks: DoctorCheck[] = [
    check("route", upstreamUrl === "https://doctor.invalid/v1/messages?beta=true", upstreamUrl),
    check("authorization", upstreamHeaders.get("authorization") === "Bearer doctor-access", "OAuth bearer is injected"),
    check("user-agent", (upstreamHeaders.get("user-agent") ?? "").startsWith("claude-cli/"), upstreamHeaders.get("user-agent") ?? ""),
    check("x-app", upstreamHeaders.get("x-app") === "cli", upstreamHeaders.get("x-app") ?? ""),
    warnCheck("runtime/tls", isBunRuntime(), describeRuntimeTlsFingerprint()),
    check("x-stainless-timeout", upstreamHeaders.get("x-stainless-timeout") === "600", upstreamHeaders.get("x-stainless-timeout") ?? ""),
    check("caller fingerprint filtered", !beta.includes("caller-beta") && upstreamHeaders.get("x-client-request-id") !== "caller-request-id", "caller fingerprint headers are not forwarded by default"),
    check("billable beta filtered", !beta.includes("extended-cache-ttl-"), beta),
    check("required betas", betaIncludes(beta, ["claude-code-20250219", "oauth-2025-04-20", "interleaved-thinking-2025-05-14"]), beta),
    check("model prefix stripped", upstreamBody.model === "claude-sonnet-4-5", String(upstreamBody.model)),
    check("sampling fields stripped", !("temperature" in upstreamBody) && !("top_p" in upstreamBody) && !("top_k" in upstreamBody), "temperature/top_p/top_k are removed"),
    check("incoming cache_control stripped", !hasNestedKey(upstreamBody.messages, "cache_control"), "no cache_control keys remain on incoming messages"),
    warnCheck("system template", Array.isArray(upstreamBody.system) && upstreamBody.system.length === 3, "Claude Code 3-block system template is reconstructed"),
    warnCheck("metadata.user_id", hasMetadataUserId(upstreamBody), "Claude Code metadata.user_id is reconstructed"),
    warnCheck("tool template", hasClaudeCodeToolTemplate(upstreamBody), "Claude Code bundled tool template is reconstructed"),
    warnCheck("body field order", hasClaudeCodeBodyFieldOrder(upstreamBody), Object.keys(upstreamBody).slice(0, 6).join(",")),
  ];

  return {
    name: "claude-fingerprint",
    summary: summarizeChecks(checks),
    checks,
  };
}

async function runClaudeTemplateDriftDoctor(options: {
  timeoutMs?: number;
} = {}): Promise<DoctorReport> {
  const drift = await checkClaudeCodeTemplateDrift({ timeoutMs: options.timeoutMs });
  const checks: DoctorCheck[] = drift.checks.map((check) => ({
    name: check.name,
    status: check.ok ? "pass" : "fail",
    detail: check.detail,
  }));

  checks.unshift(
    warnCheck(
      "bundled version",
      drift.bundledVersion === drift.capturedVersion,
      `bundled=${drift.bundledVersion ?? "unknown"} captured=${drift.capturedVersion ?? "unknown"}`,
    ),
  );

  return {
    name: "claude-template-drift",
    summary: summarizeChecks(checks),
    checks,
  };
}

async function runClaudeWireCompareDoctor(options: {
  timeoutMs?: number;
} = {}): Promise<DoctorReport> {
  const capture = await captureClaudeCodeWireRequest({ timeoutMs: options.timeoutMs });
  const checks: DoctorCheck[] = [];

  if (!capture.binaryPath) {
    checks.push(check("claude binary", false, "Claude Code CLI binary was not found"));
    return { name: "claude-wire-compare", summary: summarizeChecks(checks), checks };
  }
  checks.push(check("claude binary", true, capture.binaryPath));

  if (!capture.request) {
    checks.push(check("capture", false, "Failed to capture a Claude Code request through loopback"));
    return { name: "claude-wire-compare", summary: summarizeChecks(checks), checks };
  }
  checks.push(check("capture", true, "Captured local Claude Code request through loopback"));

  const kyoli = await captureKyoliClaudeOutbound(capture.request);
  const capturedHeaders = capture.request.headers;
  const kyoliHeaders = kyoli.headers;
  const capturedBody = capture.request.body;
  const kyoliBody = kyoli.body;

  checks.push(
    check("route", kyoli.url === "https://doctor.invalid/v1/messages?beta=true", kyoli.url),
    compareHeader("accept", capturedHeaders, kyoliHeaders),
    compareHeader("content-type", capturedHeaders, kyoliHeaders),
    compareHeader("user-agent", capturedHeaders, kyoliHeaders),
    compareHeader("x-app", capturedHeaders, kyoliHeaders),
    compareHeader("anthropic-version", capturedHeaders, kyoliHeaders),
    compareHeader("anthropic-dangerous-direct-browser-access", capturedHeaders, kyoliHeaders),
    compareHeader("x-stainless-timeout", capturedHeaders, kyoliHeaders),
    check("authorization shape", kyoliHeaders.get("authorization") === "Bearer doctor-access", "Kyoli injects OAuth bearer without reusing captured token"),
    compareClientRequestId(capturedHeaders, kyoliHeaders),
    compareBetaHeader(capturedHeaders["anthropic-beta"], kyoliHeaders.get("anthropic-beta")),
    warnCheck("header order", comparableHeaderOrder(capture.request.rawHeaders).join(",") === comparableKyoliHeaderOrder(kyoli.rawHeaderNames).join(","), `captured=${comparableHeaderOrder(capture.request.rawHeaders).join(",")} kyoli=${comparableKyoliHeaderOrder(kyoli.rawHeaderNames).join(",")}`),
    check("body field order", Object.keys(capturedBody).join(",") === Object.keys(kyoliBody).join(","), `captured=${Object.keys(capturedBody).join(",")} kyoli=${Object.keys(kyoliBody).join(",")}`),
    check("model", readString(capturedBody.model) === readString(kyoliBody.model), String(kyoliBody.model)),
    check("messages", stableJson(stripCacheControlClone(capturedBody.messages)) === stableJson(stripCacheControlClone(kyoliBody.messages)), "message payload matches after cache_control stripping"),
    compareSystemBlocks(capturedBody, kyoliBody),
    compareToolNames(capturedBody, kyoliBody),
    compareMetadataUserId(capturedBody, kyoliBody),
    compareOptionalBodyField("thinking", capturedBody, kyoliBody),
    compareOptionalBodyField("context_management", capturedBody, kyoliBody),
    compareOptionalBodyField("output_config", capturedBody, kyoliBody),
    compareOptionalBodyField("stream", capturedBody, kyoliBody),
  );

  return {
    name: "claude-wire-compare",
    summary: summarizeChecks(checks),
    checks,
  };
}

async function captureKyoliClaudeOutbound(
  captured: ClaudeCodeCapturedRequest,
): Promise<{ body: Record<string, unknown>; headers: Headers; rawHeaderNames: string[]; url: string }> {
  let upstreamUrl = "";
  let upstreamHeaders = new Headers();
  let upstreamRawHeaderNames: string[] = [];
  let upstreamBody: Record<string, unknown> = {};
  const userId = readMetadataUserId(captured.body);

  const store = new MemoryAccountStore();
  await store.create({
    provider: "claude-code",
    kind: "oauth",
    credentials: {
      accessToken: "doctor-access",
      expiresAt: Date.now() + 60 * 60 * 1000,
      refreshToken: "doctor-refresh",
    },
    metadata: {
      accountId: userId.account_uuid ?? "doctor-account",
      deviceId: userId.device_id ?? "doctor-device",
      cachedUsageAt: Date.now(),
    },
  });

  const provider = createClaudeCodeProvider({
    accounts: new StickyAccountPool(store),
    allowLiveMessages: true,
    baseUrl: "https://doctor.invalid",
    usageRefreshIntervalMs: 0,
    usageRefresh: async () => ({ cachedUsageAt: Date.now() }),
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      upstreamUrl = String(input);
      upstreamHeaders = new Headers(init?.headers);
      upstreamRawHeaderNames = readHeaderOrder(init?.headers);
      upstreamBody = readRecord(JSON.parse(String(init?.body))) ?? {};
      return new Response(JSON.stringify({ id: "msg_wire_compare", type: "message" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch,
  });

  const body = createKyoliWireCompareBody(captured.body);
  await provider.handleRequest({
    request: new Request("http://127.0.0.1:2021/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
    route: "/v1/messages",
    sessionKey: "doctor-claude-wire-compare",
    body,
    model: readString(body.model),
  });

  return {
    body: upstreamBody,
    headers: upstreamHeaders,
    rawHeaderNames: upstreamRawHeaderNames,
    url: upstreamUrl,
  };
}

function createKyoliWireCompareBody(capturedBody: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const model = readString(capturedBody.model) ?? "claude-sonnet-4-5";
  body.model = model.includes("/") ? model : `claude-code/${model}`;

  for (const key of ["messages", "max_tokens", "thinking", "context_management", "output_config", "stream"]) {
    if (key in capturedBody) body[key] = structuredClone(capturedBody[key]);
  }
  if (!("max_tokens" in body)) body.max_tokens = 1024;
  return body;
}

function compareHeader(
  key: string,
  capturedHeaders: Record<string, string>,
  kyoliHeaders: Headers,
): DoctorCheck {
  const captured = capturedHeaders[key] ?? "";
  const kyoli = kyoliHeaders.get(key) ?? "";
  return check(key, captured === kyoli, `captured=${captured || "(missing)"} kyoli=${kyoli || "(missing)"}`);
}

function compareBetaHeader(captured: string | undefined, kyoli: string | null): DoctorCheck {
  const capturedNormalized = normalizeBeta(captured).filter((beta) => !beta.startsWith("extended-cache-ttl-"));
  const kyoliNormalized = normalizeBeta(kyoli ?? "");
  return check(
    "anthropic-beta",
    stableJson(capturedNormalized) === stableJson(kyoliNormalized),
    `captured=${capturedNormalized.join(",")} kyoli=${kyoliNormalized.join(",")}`,
  );
}

function compareClientRequestId(
  capturedHeaders: Record<string, string>,
  kyoliHeaders: Headers,
): DoctorCheck {
  const captured = capturedHeaders["x-client-request-id"];
  const kyoli = kyoliHeaders.get("x-client-request-id") ?? "";
  const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(kyoli);
  return check(
    "client request id",
    uuidShape,
    `captured=${captured ?? "(missing)"} kyoli=${uuidShape ? "generated-uuid" : kyoli || "(missing)"}`,
  );
}

function compareSystemBlocks(
  capturedBody: Record<string, unknown>,
  kyoliBody: Record<string, unknown>,
): DoctorCheck {
  const captured = readSystemTexts(capturedBody);
  const kyoli = readSystemTexts(kyoliBody);
  const ok = isBillingHeader(captured[0]) &&
    isBillingHeader(kyoli[0]) &&
    captured[1] === kyoli[1] &&
    scrubClaudeSystemPrompt(captured[2] ?? "") === scrubClaudeSystemPrompt(kyoli[2] ?? "");
  return check(ok ? "system blocks" : "system blocks", ok, `captured=${captured.length} blocks kyoli=${kyoli.length} blocks`);
}

function compareToolNames(
  capturedBody: Record<string, unknown>,
  kyoliBody: Record<string, unknown>,
): DoctorCheck {
  const captured = readToolNames(capturedBody.tools);
  const kyoli = readToolNames(kyoliBody.tools);
  return check("tool names", stableJson(captured) === stableJson(kyoli), `captured=${captured.length} kyoli=${kyoli.length}`);
}

function compareMetadataUserId(
  capturedBody: Record<string, unknown>,
  kyoliBody: Record<string, unknown>,
): DoctorCheck {
  const captured = readMetadataUserId(capturedBody);
  const kyoli = readMetadataUserId(kyoliBody);
  const ok = Boolean(captured.account_uuid) &&
    captured.account_uuid === kyoli.account_uuid &&
    Boolean(captured.device_id) &&
    captured.device_id === kyoli.device_id &&
    Boolean(kyoli.session_id);
  return check("metadata.user_id", ok, `account=${kyoli.account_uuid ?? "(missing)"} device=${kyoli.device_id ? "present" : "missing"} session=${kyoli.session_id ? "present" : "missing"}`);
}

function compareOptionalBodyField(
  key: string,
  capturedBody: Record<string, unknown>,
  kyoliBody: Record<string, unknown>,
): DoctorCheck {
  if (!(key in capturedBody)) return check(key, !(key in kyoliBody), "not present in captured request");
  return check(key, stableJson(capturedBody[key]) === stableJson(kyoliBody[key]), "matches captured request");
}

function normalizeBeta(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((beta) => beta.trim())
    .filter(Boolean);
}

function comparableHeaderOrder(rawHeaders: string[]): string[] {
  const ignored = new Set(["authorization", "connection", "host", "accept-encoding", "content-length"]);
  const seen = new Set<string>();
  const order: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const key = rawHeaders[index]?.toLowerCase();
    if (!key || ignored.has(key) || seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return order;
}

function comparableKyoliHeaderOrder(rawHeaderNames: string[]): string[] {
  const ignored = new Set(["authorization"]);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const name of rawHeaderNames) {
    const key = name.toLowerCase();
    if (!key || ignored.has(key) || seen.has(key)) continue;
    seen.add(key);
    order.push(key);
  }
  return order;
}

function readHeaderOrder(headers: HeadersInit | undefined): string[] {
  if (!headers) return [];
  if (Array.isArray(headers)) return headers.map(([name]) => name);
  return [...new Headers(headers).keys()];
}

function readSystemTexts(body: Record<string, unknown>): string[] {
  return Array.isArray(body.system)
    ? body.system.map((block) => readString(readRecord(block)?.text) ?? "")
    : [];
}

function readToolNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((tool) => readString(readRecord(tool)?.name)).filter((name): name is string => Boolean(name))
    : [];
}

function readMetadataUserId(body: Record<string, unknown>): Record<string, string | undefined> {
  const userId = readString(readRecord(body.metadata)?.user_id);
  if (!userId) return {};
  try {
    const parsed = JSON.parse(userId) as unknown;
    const record = readRecord(parsed);
    return {
      account_uuid: readString(record?.account_uuid),
      device_id: readString(record?.device_id),
      session_id: readString(record?.session_id),
    };
  } catch {
    return {};
  }
}

function isBillingHeader(value: string | undefined): boolean {
  return Boolean(value?.match(/^x-anthropic-billing-header: cc_version=\d+\.\d+\.\d+\.[0-9a-f]{3}; cc_entrypoint=sdk-cli; cch=[0-9a-f]{5};$/));
}

function stripCacheControlClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stripCacheControlClone(entry));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "cache_control")
      .map(([key, entry]) => [key, stripCacheControlClone(entry)]),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function scrubClaudeSystemPrompt(systemPrompt: string): string {
  return cleanupRemovedSections(scrubText(removeHostContextSections(systemPrompt)));
}

function scrubText(text: string): string {
  return text
    .replace(/\/Users\/(?!user(?:\/|$))[A-Za-z0-9._-]+/g, "/Users/user")
    .replace(/\/home\/(?!user(?:\/|$))[A-Za-z0-9._-]+/g, "/home/user")
    .replace(/([A-Za-z]:\\Users\\)(?!user(?:\\|$))[A-Za-z0-9._-]+/g, "$1user")
    .replace(/^Current branch: .+$/gm, "Current branch: (dynamic)")
    .replace(/^Main branch \(you will usually use this for PRs\): .+$/gm, "Main branch (you will usually use this for PRs): (dynamic)")
    .replace(/^Git user: .+$/gm, "Git user: (dynamic)");
}

function removeHostContextSections(systemPrompt: string): string {
  const skippedSections = new Set(["environment", "automemory", "claudemd", "useremail", "currentdate", "gitstatus"]);
  const lines = systemPrompt.split("\n");
  const keptLines: string[] = [];
  let skippedHeadingDepth: number | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*$/);
    if (headingMatch) {
      const headingDepth = headingMatch[1]!.length;
      const sectionName = headingMatch[2]!.toLowerCase().replace(/[^a-z0-9]+/g, "");
      if (skippedSections.has(sectionName)) {
        skippedHeadingDepth = headingDepth;
        continue;
      }
      if (skippedHeadingDepth !== null && headingDepth > skippedHeadingDepth) continue;
      skippedHeadingDepth = null;
      keptLines.push(line);
      continue;
    }
    if (skippedHeadingDepth === null) keptLines.push(line);
  }

  return keptLines.join("\n")
    .replace(/\n\nStatus:\n(?:[\s\S]*?)\n\nRecent commits:\n/g, "\n\nStatus:\n(dynamic)\n\nRecent commits:\n")
    .replace(/(\n\nRecent commits:\n)(?:[0-9a-f]{7,}\s.*\n?)+/g, "$1(dynamic)\n");
}

function cleanupRemovedSections(text: string): string {
  return text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^(?:\s*\n)+/, "")
    .replace(/(?:\n\s*)+$/, "");
}

async function runClaudeSmokeDoctor(
  store: AccountStore,
  config: Awaited<ReturnType<typeof loadCliConfig>>,
  options: {
    model?: string;
  } = {},
): Promise<DoctorReport> {
  const model = options.model ?? "anthropic/claude-sonnet-4-5";
  const trace: AccountExecutionTraceEvent[] = [];
  const pool = new StickyAccountPool(store, {
    strategy: config.accountSelectionStrategy,
    softQuotaThresholdPercent: config.softQuotaThresholdPercent,
    planWeights: config.planWeights,
  });
  const accounts = await store.listByProvider("claude-code");
  const gateway = createGateway({
    accounts: store,
    providers: [
      createClaudeCodeProvider({
        accounts: pool,
        onTrace: (event) => trace.push(event),
        usageRefreshIntervalMs: config.usageRefreshIntervalMs,
      }),
    ],
  });

  const response = await gateway.fetch(
    new Request("http://127.0.0.1:2021/v1/messages/count_tokens", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-kyoli-session-id": "smoke-count-tokens",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "Count tokens for smoke check." }],
      }),
    }),
  );
  const payload = await response.clone().json().catch(async () => ({ text: await response.text().catch(() => "") }));
  const selected = trace.filter((event) => event.type === "selected");
  const responseEvents = trace.filter((event) => event.type === "response");
  const statusDetail = `status=${response.status} ${truncate(JSON.stringify(payload), 240)}`;

  const checks: DoctorCheck[] = [
    check("account inventory", accounts.length > 0, `${accounts.length} claude-code account(s) found`),
    check("count_tokens route", response.status === 200, statusDetail),
    check("account selected", selected.length > 0, selected.map((event) => event.accountId ?? "unknown").join(",") || "no account selected"),
    warnCheck(
      "rate-limit trace",
      responseEvents.every((event) => event.status !== 429),
      responseEvents.map((event) => `${event.accountId ?? "unknown"}:${event.status}`).join(",") || "no upstream response trace",
    ),
  ];

  return {
    name: "claude-smoke",
    summary: summarizeChecks(checks),
    checks,
  };
}

function check(name: string, ok: boolean, detail: string): DoctorCheck {
  return {
    name,
    status: ok ? "pass" : "fail",
    detail,
  };
}

function warnCheck(name: string, ok: boolean, detail: string): DoctorCheck {
  return {
    name,
    status: ok ? "pass" : "warn",
    detail,
  };
}

function findShellClaudeBinary(): string | undefined {
  try {
    const command = process.platform === "win32" ? "where" : "which";
    const output = execFileSync(command, ["claude"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      windowsHide: true,
    });
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  } catch {
    return undefined;
  }
}

function binaryContains(path: string, marker: string): boolean {
  try {
    return readFileSync(path).includes(marker);
  } catch {
    return false;
  }
}

function readBooleanEnv(name: string): boolean {
  const value = process.env[name]?.toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isBunRuntime(): boolean {
  return typeof (process.versions as Record<string, string | undefined>).bun === "string";
}

function describeRuntimeTlsFingerprint(): string {
  const bunVersion = (process.versions as Record<string, string | undefined>).bun;
  if (bunVersion) return `bun-match candidate: Bun ${bunVersion}`;
  return `node-only: Node ${process.version} uses OpenSSL TLS, which differs from Claude Code's Bun/BoringSSL shape`;
}

function summarizeChecks(checks: DoctorCheck[]): DoctorReport["summary"] {
  return {
    pass: checks.filter((check) => check.status === "pass").length,
    warn: checks.filter((check) => check.status === "warn").length,
    fail: checks.filter((check) => check.status === "fail").length,
  };
}

function printDoctorReport(report: DoctorReport): void {
  console.log(`${report.name}: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`);
  for (const check of report.checks) {
    console.log(`${check.status.toUpperCase().padEnd(4)}  ${check.name} - ${check.detail}`);
  }
}

function runAndPrintDoctorReport(report: DoctorReport, argv: string[]): void {
  printMaybeJsonDoctorReport(report, argv);
  setDoctorExitCode(report);
}

function printMaybeJsonDoctorReport(report: DoctorReport, argv: string[]): void {
  if (argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  printDoctorReport(report);
}

function setDoctorExitCode(report: DoctorReport): void {
  if (report.summary.fail > 0) process.exitCode = 1;
}

function combineDoctorReports(name: string, reports: DoctorReport[]): DoctorReport {
  const checks = reports.flatMap((report) =>
    report.checks.map((check) => ({
      ...check,
      name: `${report.name}/${check.name}`,
    })),
  );
  return { name, summary: summarizeChecks(checks), checks };
}

function withDoctorName(report: DoctorReport, name: string): DoctorReport {
  return { ...report, name };
}

async function runOpenCodeInstallDoctor(
  argv: string[],
  config: Awaited<ReturnType<typeof loadCliConfig>>,
): Promise<DoctorReport> {
  const result = await installOpenCode(config, {
    configDir: readStringFlag(argv, "--config-dir"),
    dryRun: true,
    force: argv.includes("--force"),
    includeModels: !argv.includes("--no-models"),
    allModels: argv.includes("--all-models"),
    preserveOpenAI: argv.includes("--preserve-openai"),
  });
  const checks: DoctorCheck[] = [
    check("config path", result.configPath.endsWith("opencode.json"), result.configPath),
    check("openai provider", result.providers.some((provider) => provider.id === "openai"), "openai provider configured"),
    check("anthropic provider", result.providers.some((provider) => provider.id === "anthropic"), "anthropic provider configured"),
    warnCheck("models source", result.modelSource !== "none", result.modelSource),
    warnCheck("warnings", result.warnings.length === 0, result.warnings.join("; ") || "none"),
  ];

  if (argv.includes("--run")) {
    const run = await runInstalledOpenCode(config, {
      command: readStringFlag(argv, "--opencode-bin"),
      expectedText: readStringFlag(argv, "--expect"),
      model: readStringFlag(argv, "--model"),
      timeoutMs: readOptionalNumber(readStringFlag(argv, "--timeout-ms")),
      keepTemp: argv.includes("--keep-temp"),
      includeModels: !argv.includes("--no-models"),
      allModels: argv.includes("--all-models"),
      preserveOpenAI: argv.includes("--preserve-openai"),
    });
    checks.push(check(
      "opencode run",
      run.ok,
      `${run.detail}${run.model ? ` model=${run.model}` : ""}${run.rootDir ? ` temp=${run.rootDir}` : ""}`,
    ));
  }

  return { name: "opencode", summary: summarizeChecks(checks), checks };
}

function betaIncludes(beta: string, required: string[]): boolean {
  const values = new Set(beta.split(",").map((value) => value.trim()).filter(Boolean));
  return required.every((value) => values.has(value));
}

function hasNestedKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => hasNestedKey(item, key));
  }

  const record = readRecord(value);
  if (!record) return false;
  if (Object.prototype.hasOwnProperty.call(record, key)) return true;
  return Object.values(record).some((nested) => hasNestedKey(nested, key));
}

function hasMetadataUserId(body: Record<string, unknown>): boolean {
  const metadata = readRecord(body.metadata);
  if (!metadata || typeof metadata.user_id !== "string") return false;

  try {
    const parsed = readRecord(JSON.parse(metadata.user_id));
    return Boolean(parsed?.device_id && parsed.account_uuid && parsed.session_id);
  } catch {
    return false;
  }
}

function hasClaudeCodeToolTemplate(body: Record<string, unknown>): boolean {
  if (!Array.isArray(body.tools) || body.tools.length < 20) return false;

  const names = body.tools
    .map((tool) => readString(readRecord(tool)?.name))
    .filter((name): name is string => Boolean(name));
  const required = ["Agent", "AskUserQuestion", "Bash", "Read", "Write", "TodoWrite"];
  if (!required.every((name) => names.includes(name))) return false;

  return body.tools.every((tool) => readRecord(readRecord(tool)?.input_schema));
}

function hasClaudeCodeBodyFieldOrder(body: Record<string, unknown>): boolean {
  return Object.keys(body).slice(0, 6).join(",") ===
    "model,messages,system,tools,metadata,max_tokens";
}

function formatAccountState(account: AccountRecord): string {
  if (account.reauthRequiredReason) return "reauth_required";
  if (!account.enabled) return "disabled";
  if (account.rateLimitResetAt && new Date(account.rateLimitResetAt).getTime() > Date.now()) {
    return "rate-limited";
  }
  if (account.authCooldownUntil && new Date(account.authCooldownUntil).getTime() > Date.now()) {
    return "auth-cooldown";
  }
  return "ready";
}

function formatUsage(value: unknown): string {
  const usage = readRecord(value);
  if (!usage) return "-";

  const parts = [
    ["5h", readUsageUtilization(usage.five_hour)],
    ["7d", readUsageUtilization(usage.seven_day)],
    ["sonnet", readUsageUtilization(usage.seven_day_sonnet)],
  ]
    .filter((entry): entry is [string, number] => typeof entry[1] === "number")
    .map(([label, utilization]) => `${label}:${Math.round(utilization)}%`);

  return parts.length > 0 ? parts.join(" ") : "-";
}

function readUsageUtilization(value: unknown): number | undefined {
  const record = readRecord(value);
  return record ? readOptionalNumber(String(record.utilization)) : undefined;
}

function formatRelativeTime(value: string | undefined): string {
  if (!value) return "-";

  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;

  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return "future";
  if (diffMs < 60_000) return `${Math.max(0, Math.round(diffMs / 1000))}s ago`;
  if (diffMs < 60 * 60_000) return `${Math.round(diffMs / 60_000)}m ago`;
  if (diffMs < 24 * 60 * 60_000) return `${Math.round(diffMs / (60 * 60_000))}h ago`;
  return `${Math.round(diffMs / (24 * 60 * 60_000))}d ago`;
}

function formatRelativeFuture(value: string): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return value;

  const diffMs = timestamp - Date.now();
  if (diffMs <= 0) return "now";
  if (diffMs < 60_000) return `${Math.ceil(diffMs / 1000)}s`;
  if (diffMs < 60 * 60_000) return `${Math.ceil(diffMs / 60_000)}m`;
  if (diffMs < 24 * 60 * 60_000) return `${Math.ceil(diffMs / (60 * 60_000))}h`;
  return `${Math.ceil(diffMs / (24 * 60 * 60_000))}d`;
}

function printTable(rows: Array<Record<string, string>>, columns: string[]): void {
  const widths = Object.fromEntries(
    columns.map((column) => [
      column,
      Math.max(column.length, ...rows.map((row) => row[column]?.length ?? 0)),
    ]),
  ) as Record<string, number>;

  console.log(columns.map((column) => column.padEnd(widths[column] ?? column.length)).join("  "));
  console.log(columns.map((column) => "-".repeat(widths[column] ?? column.length)).join("  "));
  for (const row of rows) {
    console.log(columns.map((column) => (row[column] ?? "").padEnd(widths[column] ?? column.length)).join("  "));
  }
}

function readProviderArg(value: string | undefined): ProviderId | undefined {
  if (value === "codex" || value === "claude-code") return value;
  if (!value) return undefined;
  throw new Error(`Unsupported provider: ${value}`);
}

function readOptionalProviderArg(value: string | undefined): ProviderId | undefined {
  if (!value || value.startsWith("--")) return undefined;
  return readProviderArg(value);
}

function readImportProviderFlag(argv: string[]): OpenCodeImportProvider {
  const value = readStringFlag(argv, "--provider") ?? "all";
  if (value === "all" || value === "codex" || value === "claude-code") return value;
  throw new Error(`Unsupported import provider: ${value}`);
}

function readCodexSmokeRouteFlag(
  argv: string[],
): "/backend-api/codex/responses" | "/v1/responses" | "/v1/chat/completions" | undefined {
  const value = readStringFlag(argv, "--route");
  if (!value) return undefined;
  if (
    value === "/backend-api/codex/responses" ||
    value === "/v1/responses" ||
    value === "/v1/chat/completions"
  ) {
    return value;
  }
  throw new Error(`Unsupported codex smoke route: ${value}`);
}

function readStringFlag(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;

  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function readOptionalNumber(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function isExpired(value: unknown): boolean {
  const expiresAt = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return expiresAt <= Date.now() + 60_000;
}

function warnIfAdminTokenMissingForPublicHost(config: Awaited<ReturnType<typeof loadCliConfig>>): void {
  if (config.adminToken || !isPublicBindHost(config.host)) return;

  console.warn(
    "Warning: KYOLI_ADMIN_TOKEN is not set while the gateway is bound to a public interface. /admin/* routes are unprotected.",
  );
}

function createServeTraceLogger(
  config: Awaited<ReturnType<typeof loadCliConfig>>,
  requestLogs?: RequestLogStore,
): ((event: AccountExecutionTraceEvent) => void) | undefined {
  if (config.logLevel !== "debug" && !requestLogs) return undefined;

  return (event) => {
    requestLogs?.createRequestLog({
      requestId: event.requestId,
      provider: event.provider,
      route: readTraceRoute(event.route),
      model: event.model,
      sessionKey: event.sessionKey,
      accountId: "accountId" in event ? event.accountId : undefined,
      eventType: event.type,
      attempt: "attempt" in event ? event.attempt : undefined,
      status: "status" in event ? event.status : undefined,
      retryable: "retryable" in event ? event.retryable : undefined,
      message: "message" in event ? event.message : undefined,
    });

    if (config.logLevel !== "debug") return;

    if (event.type === "selected") {
      console.debug(
        `[kyoli] ${event.provider} selected attempt=${event.attempt} account=${formatTraceAccount(event.accountId)} session=${event.sessionKey}`,
      );
      return;
    }

    if (event.type === "response") {
      console.debug(
        `[kyoli] ${event.provider} response attempt=${event.attempt} status=${event.status} retryable=${event.retryable} account=${formatTraceAccount(event.accountId)} session=${event.sessionKey}`,
      );
      return;
    }

    if (event.type === "retry") {
      console.debug(
        `[kyoli] ${event.provider} retry attempt=${event.attempt} status=${event.status} account=${formatTraceAccount(event.accountId)} session=${event.sessionKey}`,
      );
      return;
    }

    if (event.type === "credential_unavailable") {
      console.debug(
        `[kyoli] ${event.provider} credential_unavailable account=${formatTraceAccount(event.accountId)} session=${event.sessionKey}`,
      );
      return;
    }

    console.debug(
      `[kyoli] ${event.provider} missing excluded=${event.excludedAccountIds.length} hadRetryableResponse=${event.hadRetryableResponse} session=${event.sessionKey}`,
    );
  };
}

function readTraceRoute(value: string | undefined) {
  if (
    value === "/v1/models" ||
    value === "/v1/responses" ||
    value === "/v1/chat/completions" ||
    value === "/v1/messages" ||
    value === "/v1/messages/count_tokens" ||
    value === "/backend-api/codex/responses" ||
    value === "/backend-api/files" ||
    value === "/backend-api/files/uploaded"
  ) {
    return value;
  }
  return undefined;
}

function formatTraceAccount(accountId: string | undefined): string {
  return accountId ? accountId.slice(0, 8) : "-";
}

function isPublicBindHost(host: string | undefined): boolean {
  return host === "0.0.0.0" || host === "::" || host === "[::]";
}

function printHelp(): void {
  console.log(`kyoli-gam

Usage:
  # Server Mode
  kyoli serve [--port 2021] [--config ~/.config/kyoli-gam/config.json]
  kyoli login codex [--manual|--headless|--no-browser]
  kyoli login claude [--manual|--headless|--no-browser]

  # Accounts
  kyoli accounts list [codex|claude-code]
  kyoli accounts status [codex|claude-code] [--json]
  kyoli accounts show <id>
  kyoli accounts enable <id>
  kyoli accounts disable <id>
  kyoli accounts pause <id>
  kyoli accounts reactivate <id>
  kyoli accounts delete <id>
  kyoli accounts refresh <id>
  kyoli accounts reset <id> [--enable]
  kyoli accounts reset-expired [codex|claude-code] [--enable]
  kyoli accounts import opencode [--dry-run] [--sync] [--provider all|codex|claude-code] [--config-dir ~/.config/opencode]

  # OpenCode Server Mode integration
  kyoli install opencode [--dry-run] [--force] [--no-models] [--all-models] [--preserve-openai] [--config-dir ~/.config/opencode] [--json]
  kyoli restore opencode [--backup <path>] [--dry-run] [--config-dir ~/.config/opencode] [--json]

  # Doctors
  kyoli doctor [--json]
  kyoli doctor pool [--json]
  kyoli doctor codex [--file|--e2e|--load] [--json]
  kyoli doctor claude [--binary|--template|--wire|--smoke] [--json]
  kyoli doctor opencode [--run] [--config-dir ~/.config/opencode] [--json]

  # Config
  kyoli config path
  kyoli config show
  kyoli config default
  kyoli config init [--force]

Modes:
  Server Mode:
    Run kyoli serve and point OpenCode, Codex CLI, or SDK clients at one local account pool.

  OpenCode Plugin Mode:
    No kyoli server. Add opencode-codex-multi-account and/or
    opencode-anthropic-multi-account to OpenCode's plugin array, then run:
      opencode auth login

Docs:
  README.md
  docs/server-mode-operations.md
  docs/opencode-plugin-usage.md
  docs/opencode-plugin-mode.md
  docs/codex-release-checklist.md

Environment:
  KYOLI_CONFIG_PATH=~/.config/kyoli-gam/config.json
  KYOLI_HOST=127.0.0.1
  KYOLI_PORT=2021
  KYOLI_ACCOUNT_SELECTION_STRATEGY=sticky|round-robin|weighted
  KYOLI_SOFT_QUOTA_THRESHOLD_PERCENT=90
  KYOLI_PLAN_WEIGHTS=max=3,pro=2,free=1
  KYOLI_USAGE_REFRESH_INTERVAL_MS=300000
  KYOLI_MAX_CONCURRENT_REQUESTS=0
  KYOLI_ADMIN_TOKEN=change-me
  KYOLI_LOG_LEVEL=silent|info|debug
  KYOLI_CLAUDE_CODE_PATH=/path/to/claude
  KYOLI_CLAUDE_ALLOW_LIVE_MESSAGES=0
`);
}
