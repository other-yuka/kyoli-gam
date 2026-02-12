# Project Architecture Blueprint

> **kyoli-gam monorepo** — OAuth Multi-Account Plugin System for OpenCode  
> Generated: 2026-02-12 | Based on: Full source analysis of all packages

---

## Table of Contents

1. [Architectural Overview](#1-architectural-overview)
2. [Architecture Visualization](#2-architecture-visualization)
3. [Core Architectural Components](#3-core-architectural-components)
4. [Architectural Layers and Dependencies](#4-architectural-layers-and-dependencies)
5. [Data Architecture](#5-data-architecture)
6. [Cross-Cutting Concerns Implementation](#6-cross-cutting-concerns-implementation)
7. [Service Communication Patterns](#7-service-communication-patterns)
8. [Technology-Specific Architectural Patterns](#8-technology-specific-architectural-patterns)
9. [Implementation Patterns](#9-implementation-patterns)
10. [Testing Architecture](#10-testing-architecture)
11. [Deployment Architecture](#11-deployment-architecture)
12. [Extension and Evolution Patterns](#12-extension-and-evolution-patterns)
13. [Architectural Pattern Examples](#13-architectural-pattern-examples)
14. [Architectural Decision Records](#14-architectural-decision-records)
15. [Architecture Governance](#15-architecture-governance)
16. [Blueprint for New Development](#16-blueprint-for-new-development)

---

## 1. Architectural Overview

### 1.1 Project Identity

**kyoli-gam** is a TypeScript monorepo producing OpenCode CLI plugins for OAuth-based multi-account management. Each plugin allows users to pool multiple OAuth accounts for a specific AI provider (Anthropic Claude, OpenAI Codex) and transparently rotate between them when rate limits are hit.

### 1.2 Architectural Pattern: Provider-Adapter Plugin System

The architecture follows a **Layered Plugin System with Provider Adapters**:

| Layer | Package | Responsibility |
|-------|---------|----------------|
| **Layer 0: Adapter** | `kyoligam-oauth-adapters` | Provider-agnostic interface definitions and concrete adapter configurations |
| **Layer 1: Core** | `kyoligam-multi-account-core` | Shared core logic (~70% of logic): account management, storage, executor |
| **Layer 2: Plugin** | `anthropic-multi-account` | Anthropic-specific plugin entry point and transforms |
| **Layer 2: Plugin** | `codex-multi-account` | OpenAI Codex-specific plugin entry point and transforms |

### 1.3 Guiding Principles

1. **Configuration over inheritance** — Provider differences are expressed as data (adapter configs), not class hierarchies
2. **Single write path** — All disk mutations flow through `AccountStore` with file locking, preventing split-brain corruption
3. **Atomic operations** — All file writes use temp-file-then-rename to prevent corruption from crashes
4. **Schema-first types** — Valibot schemas are the single source of truth; TypeScript types are derived via `v.InferOutput`
5. **Plugin isolation** — Each plugin is a standalone npm package with its own build artifact; the host system (OpenCode) discovers plugins via configuration
6. **Defensive token management** — Deduplication of concurrent refreshes, circuit breakers for repeated failures, proactive background refresh before expiry

### 1.4 Architectural Boundaries

```
┌──────────────────────────────────────────────┐
│                 OpenCode CLI                 │  (Host system — external)
│         Plugin Discovery & Loading           │
└──────────────┬──────────────────┬────────────┘
               │                  │
    ┌──────────▼──────────┐ ┌────▼────────────────┐
    │  anthropic-multi-   │ │  codex-multi-       │
    │  account (Plugin)   │ │  account (Plugin)   │  (Layer 2: Plugin)
    └──────────┬──────────┘ └────┬────────────────┘
               │                  │
         ┌─────▼──────────────────▼────┐
         │ kyoligam-multi-account-core │  (Layer 1: Shared core)
         └─────────────┬───────────────┘
                       │
         ┌─────────────▼───────────────┐
         │  kyoligam-oauth-adapters    │  (Layer 0: Shared adapters)
         └─────────────────────────────┘
```

**Boundary enforcement**: Workspace protocol (`workspace:^`) and TypeScript path aliases ensure compile-time dependency validation. Plugins depend downward on adapters; adapters have zero dependencies on plugins.

---

## 2. Architecture Visualization

### 2.1 High-Level Subsystem Diagram

```
                          ┌────────────────────────┐
                          │    OpenCode CLI Host    │
                          │  (@opencode-ai/plugin)  │
                          └───┬────────────────┬───┘
                              │                │
                    Plugin API │                │ Plugin API
                  (auth hook)  │                │  (auth hook)
                              │                │
         ┌────────────────────▼──┐  ┌──────────▼──────────────┐
         │  Anthropic Multi-Auth │  │   Codex Multi-Auth      │
         │  (Plugin Layer)       │  │   (Plugin Layer)        │
         └───────────┬───────────┘  └──────────┬──────────────┘
                     │                          │
                     └──────────┬───────────────┘
                                │
                  ┌─────────────▼─────────────┐
                  │ kyoligam-multi-account-core│
                  │ (Shared Core Layer)       │
                  │                           │
                  │  AccountManager           │
                  │  AccountStore             │
                  │  Executor                 │
                  │  ProactiveRefresh         │
                  └─────────────┬─────────────┘
                                │
                  ┌─────────────▼─────────────┐
                  │   kyoligam-oauth-adapters  │
                  │   (Shared Adapter Layer)  │
                  │                           │
                  │  OAuthAdapter (interface)  │
                  │  anthropicOAuthAdapter     │
                  │  openAIOAuthAdapter        │
                  └───────────────────────────┘
```

### 2.2 Request Flow (Per Plugin)

```
opencode fetch(input, init)
  │
  └──▶ Plugin.auth.loader() returns { apiKey, fetch }
         │
         └──▶ executeWithAccountRotation(manager, runtimeFactory, client, input, init)
                │
                ├── 1. resolveAccount(manager, client)
                │     ├── manager.selectAccount() — strategy-based selection
                │     ├── If all rate-limited: sleep(minWaitTime) and retry
                │     └── Returns: ManagedAccount
                │
                ├── 2. runtimeFactory.getRuntime(uuid)
                │     ├── Cache hit → return cached runtime
                │     ├── Cache miss → createRuntime(uuid)
                │     │     [Anthropic]: delegates to AnthropicAuthPlugin (scoped client)
                │     │     [Codex]: direct fetch with buildRequestHeaders + transformRequestUrl
                │     └── Returns: { fetch: BaseFetch }
                │
                ├── 3. runtime.fetch(input, init) → HTTP Response
                │
                ├── 4. Response handling
                │     ├── 2xx → manager.markSuccess(uuid), return response
                │     ├── 401 → invalidate runtime, retry once, then markAuthFailure
                │     ├── 403 + revoked → markRevoked(uuid), continue rotation
                │     ├── 429 → handleRateLimitResponse(manager, ...), continue rotation
                │     └── 5xx → exponential backoff retry (up to 2x), then rotate
                │
                └── 5. Loop until success or exhausted retries
```

### 2.3 Write Path (Single Writer)

```
AccountManager ──┐
                 ├──▶ AccountStore.mutateAccount(uuid, fn)
ProactiveRefresh ┘     │
                       ├── withFileLock(storagePath)
                       │     ├── lockfile.lock(path, options)
                       │     ├── readStorageFromDisk(path)
                       │     ├── fn(account)  — mutate in memory
                       │     ├── v.safeParse(AccountStorageSchema, storage)
                       │     ├── writeAtomicText(path, JSON.stringify)
                       │     │     ├── fs.writeFile(tempPath)
                       │     │     ├── fs.chmod(tempPath, 0o600)
                       │     │     └── fs.rename(tempPath, targetPath)
                       │     └── lockfile.unlock()
                       └── return mutated account
```

### 2.4 Account Selection Strategies

```
selectAccount()
  │
  ├── Strategy: "sticky"
  │     └── Keep current account if usable → find unclaimed → find any usable → fallback
  │
  ├── Strategy: "round-robin"
  │     └── Increment cursor → find next usable+unclaimed → find next usable → fallback
  │
  └── Strategy: "hybrid"
        └── Score each account:
              Usage (0-450) + Health (0-250) + Freshness (0-60)
              + Stickiness (+120 if active) + Claimed (-200 if other process)
            → Hysteresis margin (40) prevents constant switching
```

---

## 3. Core Architectural Components

### 3.1 `kyoligam-oauth-adapters` — Provider Adapter Definitions

**Purpose**: Define the contract and concrete configurations for each OAuth provider.

**Files**: 4 source files (`types.ts`, `index.ts`, `anthropic.ts`, `openai.ts`)

#### OAuthAdapter Interface

The central abstraction — 18 fields organized into logical groups:

| Group | Fields | Purpose |
|-------|--------|---------|
| Identity | `id`, `authProviderId` | Unique provider identification |
| Display | `modelDisplayName`, `statusToolName`, `authMethodLabel`, `serviceLogName` | User-facing and logging labels |
| OAuth | `oauthClientId`, `tokenEndpoint`, `usageEndpoint`, `profileEndpoint` | OAuth protocol endpoints |
| Headers | `oauthBetaHeader`, `requestBetaHeader`, `cliUserAgent` | Per-request header requirements |
| Behavior | `toolPrefix`, `transform: OAuthAdapterTransformConfig` | Request/response transformation flags |
| Storage | `accountStorageFilename`, `planLabels` | Filesystem and display configuration |
| Status | `supported`, `unsupportedReason?` | Provider availability gate |

#### OAuthAdapterTransformConfig

Boolean flags controlling provider-specific request/response transformations:

```typescript
interface OAuthAdapterTransformConfig {
  rewriteOpenCodeBranding: boolean;   // Replace "OpenCode" with provider branding
  addToolPrefix: boolean;              // Prefix tool names with "mcp_"
  stripToolPrefixInResponse: boolean;  // Strip "mcp_" from SSE stream tool names
  enableMessagesBetaQuery: boolean;    // Append ?beta=true to messages endpoint
}
```

**Anthropic**: All `true` — Full transformation pipeline  
**OpenAI**: All `false` — Minimal passthrough

#### Extension Pattern

Adding a new provider requires:
1. Create `provider-name.ts` with a `const: OAuthAdapter` object
2. Re-export from `index.ts`
3. Zero changes to consumer packages needed for compilation; consumers opt-in by importing the new adapter

### 3.2 Plugin Packages — Internal Component Map

Both `anthropic-multi-account` and `codex-multi-account` share an identical module structure:

| Module | Responsibility | Internal Dependencies |
|--------|---------------|-----------------------|
| `index.ts` | Plugin entry point — registers auth hooks and tools with OpenCode | All modules |
| `types.ts` | Valibot schemas + derived TypeScript types | None (leaf) |
| `constants.ts` | Adapter-derived constants + timeout values | `kyoligam-oauth-adapters` |
| `auth-handler.ts` | OAuth flow orchestration + account management menu | `kyoligam-multi-account-core`, `ui/*` |
| `runtime-factory.ts` | Per-account fetch runtime creation and caching | `kyoligam-multi-account-core`, `token.ts`, `request-transform.ts` |
| `request-transform.ts` | HTTP request/response rewriting | `constants.ts` |
| `token.ts` | Token expiry check + refresh with dedup mutex | `constants.ts`, `types.ts` |
| `usage.ts` | Usage/profile API fetching and formatting | `constants.ts`, `types.ts` |
| `ui/*` | TUI components for account management | None (leaf) |

### 3.3 Key Differences Between Anthropic and Codex Plugins

| Aspect | Anthropic | Codex |
|--------|-----------|-------|
| **External auth dependency** | `opencode-anthropic-auth` (wraps AnthropicAuthPlugin) | None — implements OAuth natively |
| **OAuth flow** | Delegates to `AnthropicAuthPlugin` | Browser (PKCE + local callback server) or Device Code flow |
| **Token refresh content type** | `application/json` | `application/x-www-form-urlencoded` |
| **RuntimeFactory strategy** | Instantiates scoped `AnthropicAuthPlugin` per account | Directly builds headers + transforms URL |
| **Request transform** | Full pipeline: branding rewrite, tool prefix, beta query, SSE stream transform | URL rewrite (`/v1/responses` → `chatgpt.com/backend-api/codex/responses`) + headers |
| **Account ID extraction** | From token response `account.uuid` | From JWT claims (`id_token` or `access_token`) |
| **Extra headers** | `anthropic-beta`, `user-agent` | `ChatGPT-Account-Id`, `originator: opencode`, `User-Agent` |
| **Usage endpoint** | `api.anthropic.com/api/oauth/usage` | `chatgpt.com/backend-api/wham/usage` |
| **Plan detection** | Profile endpoint (`has_claude_pro`, `has_claude_max`) | JWT claims + WHAM `plan_type` fallback |
| **Auth method selection** | Single method (browser OAuth via external plugin) | TUI menu: Browser or Headless (device code) |

---

## 4. Architectural Layers and Dependencies

### 4.1 Layer Map

```
Layer 4: Host Integration    │ OpenCode CLI (@opencode-ai/plugin)
─────────────────────────────┤
Layer 3: Plugin Entry        │ index.ts — Plugin registration, auth hooks, tools
─────────────────────────────┤
Layer 2: Business Logic      │ executor, account-manager, auth-handler, runtime-factory
                             │ rate-limit, proactive-refresh, claims
─────────────────────────────┤
Layer 1: Infrastructure      │ account-store, storage, token, config, request-transform
                             │ usage, utils, ui/*
─────────────────────────────┤
Layer 0: Shared Definitions  │ kyoligam-oauth-adapters (types, adapter configs)
                             │ types.ts (valibot schemas), constants.ts
```

### 4.2 Dependency Rules

1. **Layer 0 → nothing** — Pure types and data; zero runtime dependencies
2. **Layer 1 → Layer 0 only** — Infrastructure modules import types/constants but not business logic
3. **Layer 2 → Layers 0-1** — Business logic composes infrastructure modules
4. **Layer 3 → Layers 0-2** — Entry point wires everything together
5. **Layer 4 → Layer 3 only** — Host system sees only the plugin export

### 4.3 Cross-Package Dependency Graph

```
anthropic-multi-account
  ├── kyoligam-oauth-adapters (workspace:*)     ← Adapter config
  ├── opencode-anthropic-auth (^0.0.13)       ← External OAuth plugin (base auth)
  ├── proper-lockfile (^4.1.2)                ← File locking for concurrent access
  └── valibot (^1.2.0)                        ← Schema validation

codex-multi-account
  ├── kyoligam-oauth-adapters (workspace:*)     ← Adapter config
  ├── proper-lockfile (^4.1.2)                ← File locking
  └── valibot (^1.2.0)                        ← Schema validation

kyoligam-oauth-adapters
  └── (no runtime dependencies)
```

**Dev dependencies** (not shipped):
- `@opencode-ai/plugin` — Type definitions for the plugin interface
- `typescript`, `@types/node`, `@types/proper-lockfile` — Build tooling

### 4.4 Circular Dependency Analysis

**No circular dependencies detected.** The dependency graph is a strict DAG:

```
types.ts ← constants.ts ← token.ts ← account-manager.ts ← executor.ts ← index.ts
                         ← config.ts ←─┘         ↑
                         ← storage.ts ← account-store.ts ←─┘
```

`account-manager.ts` references `AccountRuntimeFactory` as a type-only import, avoiding runtime circularity.

---

## 5. Data Architecture

### 5.1 Domain Model

```
AccountStorage (persisted to disk)
  ├── version: 1 (literal)
  ├── activeAccountUuid?: string
  └── accounts: StoredAccount[]
        ├── uuid?: string
        ├── label?, email?, planTier?
        ├── refreshToken: string       ← Sensitive credential
        ├── accessToken?: string       ← Short-lived, refreshable
        ├── expiresAt?: number         ← Token expiry timestamp
        ├── addedAt, lastUsed: number  ← Lifecycle timestamps
        ├── enabled: boolean
        ├── rateLimitResetAt?: number
        ├── cachedUsage?: UsageLimits
        ├── consecutiveAuthFailures: number
        ├── isAuthDisabled: boolean
        └── authDisabledReason?: string

ManagedAccount (in-memory, extends StoredAccount)
  ├── index: number                    ← Array position for display
  └── last429At?: number               ← In-memory only, not persisted

PluginConfig (persisted separately)
  ├── account_selection_strategy: "sticky" | "round-robin" | "hybrid"
  ├── cross_process_claims: boolean
  ├── soft_quota_threshold_percent: 0-100
  ├── rate_limit_min_backoff_ms, default_retry_after_ms
  ├── max_consecutive_auth_failures
  ├── token_failure_backoff_ms
  ├── proactive_refresh, proactive_refresh_buffer_seconds, proactive_refresh_interval_seconds
  ├── quiet_mode, debug
  └── (all fields optional with sensible defaults)

ClaimsMap (cross-process coordination)
  └── { [accountUuid]: { pid: number, at: number } }
```

### 5.2 Data Access Patterns

| Pattern | Implementation | Used By |
|---------|---------------|---------|
| **Repository** | `AccountStore` — all CRUD operations for `AccountStorage` | `AccountManager`, `ProactiveRefreshQueue` |
| **Single Writer** | File lock (`proper-lockfile`) serializes all mutations | `AccountStore.mutateAccount`, `mutateStorage` |
| **Atomic Write** | temp-file → rename pattern via `writeAtomicText` | All disk writes |
| **Lock-Free Read** | `readCredentials` reads without lock (atomic rename guarantees no torn reads) | `RuntimeFactory` hot path |
| **In-Memory Cache** | `AccountManager.cached` mirrors disk state, refreshed on every `selectAccount()` | Executor request loop |
| **Config Cache** | `cachedConfig` singleton, loaded once at startup | All modules via `getConfig()` |

### 5.3 Schema Validation Strategy

**Valibot** is used as the single source of truth for all data shapes:

```
Schema Definition (types.ts)
  └──▶ v.InferOutput<typeof Schema> → TypeScript type
  └──▶ v.safeParse(Schema, data)    → Runtime validation on disk reads
  └──▶ v.parse(Schema, data)        → Strict validation on API responses
```

Benefits:
- Types and runtime validation stay in sync automatically
- Disk corruption detected and handled (backup + fallback to empty)
- External API responses validated before use

### 5.4 Data Storage Locations

| Data | Path | Permissions | Format |
|------|------|-------------|--------|
| Anthropic accounts | `~/.config/opencode/anthropic-multi-account-accounts.json` | 0o600 | JSON |
| Codex accounts | `~/.config/opencode/openai-multi-account-accounts.json` | 0o600 | JSON |
| Anthropic config | `~/.config/opencode/claude-multiauth.json` | default | JSON |
| Codex config | `~/.config/opencode/chatgpt-multiauth.json` | default | JSON |
| Cross-process claims | `~/.config/opencode/multiauth-claims.json` | 0o600 | JSON |

Config directory resolution: `$OPENCODE_CONFIG_DIR` → `$XDG_CONFIG_HOME/opencode` → `~/.config/opencode`

---

## 6. Cross-Cutting Concerns Implementation

### 6.1 Authentication & Authorization

**Security Model**: OAuth 2.0 with refresh tokens

| Concern | Implementation |
|---------|---------------|
| Token storage | Refresh tokens persisted on disk with `0o600` file permissions |
| Token refresh | Automatic on expiry with 60-second buffer (`TOKEN_EXPIRY_BUFFER_MS`) |
| Refresh deduplication | In-memory mutex map prevents concurrent refresh for same account |
| Refresh timeout | 30-second abort timeout prevents indefinite hangs |
| Proactive refresh | Background queue refreshes tokens 30 minutes before expiry |
| Startup throttling | Max 3 concurrent refreshes at startup to avoid thundering herd |
| Circuit breaker | Account disabled after N consecutive auth failures (configurable, default: 3) |
| Lockout prevention | Account auto-disabled only when at least one other usable account remains |
| Permanent failure detection | HTTP 400/401/403 treated as permanent; account immediately disabled |

### 6.2 Error Handling & Resilience

```
Error Classification:
  ├── Transient (retryable)
  │     ├── 429 Rate Limited → markRateLimited + rotate to next account
  │     ├── 5xx Server Error → exponential backoff (1s-4s) + retry up to 2x
  │     ├── Network Error → rotate to next account
  │     └── Token Refresh Failure (non-permanent) → increment failure counter
  │
  ├── Permanent (non-retryable)
  │     ├── 401 Unauthorized (after retry) → markAuthFailure
  │     ├── 403 Revoked → markRevoked, disable account
  │     └── Token Refresh 400/401/403 → disable account immediately
  │
  └── Terminal (throw to host)
        ├── All accounts disabled → Error with re-auth instructions
        ├── All accounts rate-limited (no wait) → Error
        └── Retry limit exhausted → Error
```

**Retry budget**: `max(6, accountCount * 3)` attempts across all accounts before giving up.

### 6.3 Logging & Monitoring

| Level | Mechanism | When |
|-------|-----------|------|
| Debug | `client.app.log({ level: "debug" })` | Runtime creation, proactive refresh activity, gated by `config.debug` |
| Info | `client.tui.showToast({ variant: "info" })` | Account switch, load count at startup |
| Warning | `client.tui.showToast({ variant: "warning" })` | Rate limit hit, auth failure rotation, network error |
| Error | `client.tui.showToast({ variant: "error" })` | All accounts failed, token revoked |

Toast notifications suppressible via `config.quiet_mode`.

### 6.4 Validation

| Data Source | Validation Strategy |
|-------------|-------------------|
| Disk storage | `v.safeParse` — graceful fallback to empty on corruption |
| API responses | `v.parse` — throws on invalid (upstream contract violation) |
| Config file | `v.safeParse` — fallback to defaults on any error |
| Token response | `v.parse(TokenResponseSchema)` — strict validation |
| Claims file | Manual shape checking (`isClaimShape`) — tolerant of partial corruption |

### 6.5 Configuration Management

**Pattern**: File-based config with in-memory caching, atomic updates

```
loadConfig() — read once at startup → cachedConfig singleton
getConfig()  — synchronous access to cached config (never re-reads)
updateConfigField(key, value) — atomic read-modify-write → cache invalidation
resetConfigCache() — for testing
```

**Environment override**: `OPENCODE_CONFIG_DIR` overrides default config location.  
**No secrets in config**: Secrets (refresh tokens) stored in separate accounts file with restricted permissions.

---

## 7. Service Communication Patterns

### 7.1 Service Boundaries

| Boundary | Protocol | Content Type |
|----------|----------|-------------|
| Plugin ↔ OpenCode Host | In-process function calls (Plugin API) | TypeScript objects |
| Plugin ↔ Provider OAuth | HTTPS REST | JSON (Anthropic) / `x-www-form-urlencoded` (OpenAI) |
| Plugin ↔ Provider API | HTTPS REST + SSE streaming | JSON / Server-Sent Events |
| Plugin ↔ Local OAuth Server (Codex) | HTTP localhost callback | URL query parameters |
| Plugin ↔ Filesystem | File I/O with locking | JSON files |

### 7.2 Synchronous Communication

- **Token refresh**: `fetch()` with AbortController timeout (30s)
- **Usage/profile fetch**: Direct `fetch()` to provider endpoints
- **Account store mutations**: Synchronous lock → read → write → unlock cycle

### 7.3 Asynchronous Communication

- **Proactive refresh**: Background `setInterval`-like loop with token-based cancellation
- **Toast notifications**: Fire-and-forget (`void showToast(...)`) — never blocks request flow
- **Cross-process claims**: Best-effort read-modify-write, no locking (stale claims self-expire)
- **Auth sync to OpenCode**: `client.auth.set().catch(() => {})` — write-only, never reads back

### 7.4 Request Transform Pipeline

**Anthropic**:
```
Original Request
  └──▶ transformRequestUrl(input)     — Append ?beta=true to /v1/messages
  └──▶ transformRequestBody(body)     — Rewrite branding + add tool prefixes
  └──▶ buildRequestHeaders(...)       — Bearer token + merged beta headers + CLI user-agent
  └──▶ fetch()
  └──▶ createResponseStreamTransform  — Strip tool prefixes from SSE stream (line-buffered)
```

**Codex**:
```
Original Request
  └──▶ transformRequestUrl(input)     — Rewrite /v1/responses → chatgpt.com/backend-api/codex/responses
  └──▶ buildRequestHeaders(...)       — Bearer token + ChatGPT-Account-Id + originator header
  └──▶ fetch()
  └──▶ (no response transform)
```

---

## 8. Technology-Specific Architectural Patterns

### 8.1 TypeScript Patterns

**Module System**: ESNext modules (`"type": "module"`, `"module": "ESNext"`)  
**Strict Mode**: All packages use `"strict": true` with additional strictness flags:

| Flag | Packages |
|------|----------|
| `noUncheckedIndexedAccess` | anthropic, codex (not oauth-adapters) |
| `noFallthroughCasesInSwitch` | anthropic, codex |
| `forceConsistentCasingInFileNames` | anthropic, codex |
| `isolatedModules` | All |

**Path Aliases**: `kyoligam-oauth-adapters` and `kyoligam-multi-account-core` mapped to their respective `src/index.ts` in plugin tsconfigs for development-time source resolution.

**Build Output**: Separate `tsconfig.build.json` extends `tsconfig.json` with `noEmit: false`, `declaration: true`, `sourceMap: true`.

### 8.2 Build & Runtime Patterns

- Build: `esbuild src/index.ts --bundle --outdir=dist --platform=node --format=esm --packages=external`
- Codex OAuth server: Uses `Bun.serve()` for local callback server (runtime-detected via `globalThis.Bun`)
- Package manager: Bun workspaces with Turborepo

### 8.3 Valibot Schema Patterns

All schemas follow a consistent pattern:

```typescript
// 1. Schema definition (single source of truth)
export const ThingSchema = v.object({
  field: v.optional(v.string(), "default"),
  nested: v.optional(v.nullable(NestedSchema), null),
  validated: v.optional(v.pipe(v.number(), v.minValue(0), v.maxValue(100)), 50),
});

// 2. Type derivation (never manually written)
export type Thing = v.InferOutput<typeof ThingSchema>;

// 3. Disk reads: v.safeParse (graceful)
const result = v.safeParse(ThingSchema, parsed);
if (!result.success) return fallback;

// 4. API responses: v.parse (strict)
const data = v.parse(ResponseSchema, await response.json());
```

### 8.4 TUI (Terminal UI) Patterns

Custom minimal TUI implementation without external dependencies:

- **Raw mode terminal**: `stdin.setRawMode(true)` for key-by-key input
- **ANSI escape sequences**: Custom `ANSI` constant object for cursor control, colors, formatting
- **Key parsing**: Buffer-based with escape sequence timeout (50ms) for arrow keys vs. bare escape
- **Render loop**: Clear-and-redraw pattern using `ANSI.up(n)` to overwrite previous frame
- **Signal handling**: `SIGINT`/`SIGTERM` cleanup with graceful resolve(null)
- **Component model**: `select<T>()` generic for type-safe menu selections; `confirm()` built on top

---

## 9. Implementation Patterns

### 9.1 Interface Design Patterns

**Configuration Object Pattern** (OAuthAdapter):
- No abstract classes or runtime polymorphism
- Provider differences expressed as data fields
- Boolean flags (`OAuthAdapterTransformConfig`) control conditional behavior
- Label maps (`OAuthAdapterPlanLabels`) for display customization

**Result Type Pattern** (TokenRefreshResult):
```typescript
type TokenRefreshResult =
  | { ok: true; patch: CredentialRefreshPatch }
  | { ok: false; permanent: boolean; status?: number };
```
Discriminated union used throughout for API results — forces callers to handle both success and failure.

### 9.2 Service Implementation Patterns

**Singleton with Lazy Loading** (Config):
```typescript
let cachedConfig: PluginConfig | null = null;
export async function loadConfig(): Promise<PluginConfig> { /* load once */ }
export function getConfig(): PluginConfig { /* sync access */ }
```

**Factory with Cache + Lock Dedup** (RuntimeFactory):
```typescript
class AccountRuntimeFactory {
  private runtimes = new Map<string, AccountRuntime>();   // Cache
  private initLocks = new Map<string, Promise<AccountRuntime>>(); // Dedup concurrent creation
  async getRuntime(uuid: string): Promise<AccountRuntime> { /* cache-or-create */ }
  invalidate(uuid: string): void { /* cache eviction */ }
}
```

**Mutex Map Pattern** (Token refresh dedup):
```typescript
const refreshMutexByAccountId = new Map<string, Promise<TokenRefreshResult>>();
// If refresh in-flight for this account, return existing promise instead of starting new one
```

### 9.3 Repository Implementation Patterns

**AccountStore** (Repository with file locking):

| Operation | Locking | Pattern |
|-----------|---------|---------|
| `load()` | None (delegated to storage.ts) | Read-only |
| `readCredentials(uuid)` | None (atomic rename guarantees no torn reads) | Lock-free read |
| `mutateAccount(uuid, fn)` | File lock | Lock → Read → Apply → Validate → Write → Unlock |
| `mutateStorage(fn)` | File lock | Same as above but full storage mutation |
| `addAccount(account)` | File lock | Dedup check + append |
| `removeAccount(uuid)` | File lock | Filter + active UUID reassignment |

### 9.4 Plugin Entry Point Pattern

```typescript
export const Plugin: Plugin = async (ctx) => {
  // 1. Extract client from context
  const { client } = ctx as { client: PluginClient };
  
  // 2. Load config
  await loadConfig();
  
  // 3. Initialize infrastructure (lazy — not loaded until auth.loader called)
  const store = new AccountStore();
  let manager: AccountManager | null = null;
  
  // 4. Return hook object
  return {
    tool: { /* status tool registration */ },
    auth: {
      provider: ADAPTER.authProviderId,
      methods: [{ type: "oauth", authorize() { /* ... */ } }],
      async loader(getAuth, provider) {
        // 5. Initialize manager + factory on first load
        manager = await AccountManager.create(store, credentials, client);
        runtimeFactory = new AccountRuntimeFactory(...);
        
        // 6. Return fetch function that routes through executor
        return {
          apiKey: "",
          async fetch(input, init) {
            return executeWithAccountRotation(manager, runtimeFactory, client, input, init);
          },
        };
      },
    },
  };
};
```

---

## 10. Testing Architecture

### 10.1 Framework and Configuration

- **Framework**: Vitest 4.x
- **Root config**: `vitest.config.ts` with workspace projects (`packages/*`)
- **Per-package config**: Each package has its own `vitest.config.ts`
- **Runner**: `vitest run` (non-watch mode for CI)

### 10.2 Test Structure

| Package | Test Files | Focus Areas |
|---------|-----------|-------------|
| `oauth-adapters` | `adapter-contract.test.ts` | Contract testing — validates all adapters satisfy required fields |
| `anthropic-multi-account` | 8 test files | Account store, account manager, token refresh, claims, multi-process, proactive refresh, request transform, storage |
| `codex-multi-account` | 6 test files | Usage, runtime factory, executor, OAuth flows, request transform, token refresh |

### 10.3 Test Patterns

**Contract Tests** (`adapter-contract.test.ts`):
```typescript
function assertAdapterContract(adapter: OAuthAdapter) {
  expect(adapter.id.length).toBeGreaterThan(0);
  // ... validates all required fields are non-empty
}
```

**Multi-Process Tests** (`multi-process.test.ts`):
- Uses Bun Worker threads (`workers/claim-worker.ts`, `workers/storage-worker.ts`)
- Tests concurrent file access and claim coordination

**Test Helpers**:
- `helpers.ts` in each test directory for shared fixtures and utilities
- `createMinimalClient()` for mocking the plugin client in tests

---

## 11. Deployment Architecture

### 11.1 CI Pipeline (GitHub Actions)

```
Trigger: push to main, pull_request to main
Concurrency: cancel-in-progress per workflow+ref

Jobs (parallel):
  ├── typecheck: bun install → bun run typecheck
  ├── test:      bun install → bun run test
  └── build:     bun install → bun run build → verify dist output exists
```

### 11.2 Release Pipeline

```
Trigger: push tag v*.*.*

Steps (sequential):
  1. Setup: Node.js 22 + npm registry
  2. bun install
  3. bun run typecheck
  4. bun run build
  5. Verify: dist/index.js exists for both plugins
  6. npm publish --workspace anthropic-multi-account --access public
  7. npm publish --workspace codex-multi-account --access public
  8. GitHub Release with auto-generated notes
```

**Registry**: GitHub Packages (`https://npm.pkg.github.com`). Authentication uses `GITHUB_TOKEN`.

### 11.3 Build Topology

```
yarn workspaces foreach -A --topological --exclude kyoli-gam-monorepo run build

Build order (topological):
  1. kyoligam-oauth-adapters (no deps)
  2. anthropic-multi-account (depends on oauth-adapters)
  3. codex-multi-account (depends on oauth-adapters)
```

### 11.4 Package Distribution

| Package | Published | Registry | Externals |
|---------|-----------|----------|-----------|
| `kyoligam-oauth-adapters` | Source only (workspace) | Not published | — |
| `anthropic-multi-account` | dist/index.js | GitHub Packages | `@opencode-ai/plugin`, `opencode-anthropic-auth`, `valibot` |
| `codex-multi-account` | dist/index.js | GitHub Packages | `@opencode-ai/plugin`, `valibot` |

Externals are excluded from the bundle — they must be installed by the consumer (OpenCode).

---

## 12. Extension and Evolution Patterns

### 12.1 Adding a New Provider Plugin

**Step-by-step**:

1. **Adapter layer** — `packages/oauth-adapters/src/`:
   - Create `new-provider.ts` implementing `OAuthAdapter`
   - Add re-export to `index.ts`
   - Add contract test in `tests/adapter-contract.test.ts`

2. **Plugin package** — `packages/new-provider-multi-account/`:
   - Copy structure from `codex-multi-account` (newer, self-contained OAuth)
   - Update `constants.ts` to import the new adapter
   - Implement provider-specific `oauth.ts` (PKCE flow, device code, etc.)
   - Implement provider-specific `request-transform.ts`
   - Implement provider-specific `runtime-factory.ts`
   - Customize `usage.ts` for provider-specific quota endpoints
   - Update `auth-handler.ts` for provider-specific menu options
   - Wire up in `index.ts`

3. **Monorepo integration**:
    - Add `package.json` with `workspace:^` dependency on `kyoligam-oauth-adapters` and `kyoligam-multi-account-core`
   - Add tsconfig files (copy from existing plugin)
   - Update CI to verify new dist output
   - Add publish step to release workflow

**Estimated effort**: 2-4 hours for a provider with standard OAuth 2.0 + PKCE, starting from the codex template.

### 12.2 Modules Shared vs. Provider-Specific

| Shared (copy + customize) | Provider-Specific (rewrite) |
|---------------------------|----------------------------|
| `account-manager.ts` | `oauth.ts` |
| `account-store.ts` | `request-transform.ts` |
| `executor.ts` | `runtime-factory.ts` |
| `storage.ts` | `usage.ts` (API endpoints differ) |
| `claims.ts` | `auth-handler.ts` (flow entry points) |
| `proactive-refresh.ts` | `constants.ts` (adapter-derived values) |
| `config.ts` | `types.ts` (TokenResponse schema) |
| `rate-limit.ts` | |
| `utils.ts`, `ui/*` | |

### 12.3 Potential Future Abstraction

The current architecture intentionally duplicates modules across plugins rather than prematurely abstracting. The trade-off:

- **Pro**: Each plugin can diverge freely; no coupling between providers
- **Con**: Bug fixes must be applied to each plugin independently

If a third provider is added, consider extracting the shared modules (`account-manager`, `account-store`, `executor`, `storage`, `claims`, `proactive-refresh`, `config`, `rate-limit`, `utils`, `ui/*`) into a shared `kyoligam-multi-account-core` package with provider-specific hooks for the differing modules.

---

## 13. Architectural Pattern Examples

### 13.1 Layer Separation — Adapter Interface Definition

```typescript
// packages/oauth-adapters/src/types.ts — Layer 0
export interface OAuthAdapter {
  id: string;
  tokenEndpoint: string;
  transform: OAuthAdapterTransformConfig;
  // ... (18 fields total)
}
```

```typescript
// packages/oauth-adapters/src/anthropic.ts — Layer 0 (concrete)
import type { OAuthAdapter } from "./types";
export const anthropicOAuthAdapter: OAuthAdapter = {
  id: "anthropic",
  tokenEndpoint: "https://console.anthropic.com/v1/oauth/token",
  transform: { rewriteOpenCodeBranding: true, /* ... */ },
};
```

```typescript
// packages/anthropic-multi-account/src/constants.ts — Layer 1 (consumer)
import { anthropicOAuthAdapter } from "kyoligam-oauth-adapters";
export const ANTHROPIC_OAUTH_ADAPTER = anthropicOAuthAdapter;
export const ANTHROPIC_TOKEN_ENDPOINT = ANTHROPIC_OAUTH_ADAPTER.tokenEndpoint;
```

### 13.2 Schema-First Type Derivation

```typescript
// types.ts — Schema is the source of truth
export const StoredAccountSchema = v.object({
  uuid: v.optional(v.string()),
  refreshToken: v.string(),
  enabled: v.optional(v.boolean(), true),
  consecutiveAuthFailures: v.optional(v.number(), 0),
  // ...
});

// Type derived, never manually written
export type StoredAccount = v.InferOutput<typeof StoredAccountSchema>;

// Runtime validation on disk read
const validation = v.safeParse(AccountStorageSchema, parsed);
if (!validation.success) return null; // Graceful fallback
```

### 13.3 Single Write Path with File Locking

```typescript
// account-store.ts — All mutations go through this gate
async function withFileLock<T>(fn: (storagePath: string) => Promise<T>): Promise<T> {
  const storagePath = getStoragePath();
  await ensureStorageFileExists(storagePath);
  let release = await lockfile.lock(storagePath, LOCK_OPTIONS);
  try {
    return await fn(storagePath);
  } finally {
    try { await release(); } catch { /* ignore */ }
  }
}

// Usage: every mutation flows through here
async mutateAccount(uuid: string, fn: (account: StoredAccount) => void) {
  return await withFileLock(async (storagePath) => {
    const current = await readStorageFromDisk(storagePath, false);
    const account = current.accounts.find(a => a.uuid === uuid);
    fn(account);  // Apply mutation
    await writeStorageAtomic(storagePath, current);  // Atomic write
    return { ...account };
  });
}
```

### 13.4 Account Rotation Executor

```typescript
// executor.ts — Retry loop with multi-account rotation
export async function executeWithAccountRotation(
  manager: AccountManager,
  runtimeFactory: AccountRuntimeFactory,
  client: PluginClient,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const maxRetries = Math.max(6, manager.getAccountCount() * 3);
  let retries = 0;

  while (true) {
    if (++retries > maxRetries) throw new Error("Exhausted retries");
    
    const account = await resolveAccount(manager, client);
    const runtime = await runtimeFactory.getRuntime(account.uuid);
    const response = await runtime.fetch(input, init);
    
    if (response.status === 429) {
      await handleRateLimitResponse(manager, client, account, response);
      continue; // Rotate to next account
    }
    
    await manager.markSuccess(account.uuid);
    return response;
  }
}
```

---

## 14. Architectural Decision Records

### ADR-1: Configuration Objects over Class Hierarchies

**Context**: Need to support multiple OAuth providers with different behavior.  
**Decision**: Use typed constant objects (`OAuthAdapter`) with boolean flags instead of abstract classes with method overrides.  
**Rationale**: Provider differences are primarily data-level (endpoints, headers, labels), not behavioral. Configuration objects are simpler, more transparent, and avoid inheritance complexity.  
**Consequences**: Easy to add new providers; harder to express complex behavioral differences (would need new flags or separate modules).

### ADR-2: Module Duplication over Premature Abstraction

**Context**: Anthropic and Codex plugins share ~70% identical code (account-manager, executor, store, etc.).  
**Decision**: Duplicate modules in each plugin package rather than extracting a shared core package.  
**Rationale**: Two providers is too early to identify the correct abstraction boundaries. Premature extraction would couple providers and restrict independent evolution. The codex plugin already diverges in meaningful ways (OAuth flow, runtime factory, request transform).  
**Consequences**: Bug fixes must be applied twice; code drift is possible. Reassess when a third provider is added.

### ADR-3: File Locking for Multi-Process Safety

**Context**: Multiple OpenCode sessions may run simultaneously (e.g., subagents), all writing to the same account files.  
**Decision**: Use `proper-lockfile` for all disk mutations, with stale lock detection (10s) and retry backoff.  
**Rationale**: Atomic rename prevents torn reads, but can't prevent lost updates from concurrent write-after-read. File locking is the simplest correct solution for multi-process coordination.  
**Consequences**: Small performance overhead; lock contention under extreme parallelism.

### ADR-4: External Auth Plugin Delegation (Anthropic only)

**Context**: Anthropic's OAuth requires specific request transformations (branding rewrite, tool prefixes, beta headers).  
**Decision**: Delegate to `opencode-anthropic-auth` for per-account runtime creation, wrapping it with scoped clients.  
**Rationale**: The external plugin already implements the complex Anthropic-specific transform pipeline. Reusing it avoids reimplementation and stays in sync with upstream changes.  
**Consequences**: Tight coupling to `opencode-anthropic-auth` internals; requires type declarations for the untyped package.

### ADR-5: Native OAuth for Codex

**Context**: No equivalent of `opencode-anthropic-auth` exists for OpenAI/Codex.  
**Decision**: Implement OAuth 2.0 with PKCE and Device Code flow directly in the plugin.  
**Rationale**: OpenAI's OAuth is simpler (no transform pipeline needed), and implementing natively gives full control over the flow. The Bun runtime provides `Bun.serve()` for the local callback server.  
**Consequences**: More code to maintain; potential Bun-specific runtime dependency for the callback server.

### ADR-6: Valibot for Schema Validation

**Context**: Need runtime validation for disk-persisted data and API responses, with TypeScript type derivation.  
**Decision**: Use Valibot as the schema validation library.  
**Rationale**: Smaller bundle size than Zod (~6x), tree-shakeable, same TypeScript-first API. Schema-derived types eliminate type/validation drift.  
**Consequences**: Less ecosystem adoption than Zod; team must learn Valibot API.

### ADR-7: Cross-Process Claims without Distributed Locking

**Context**: Parallel OpenCode sessions should avoid claiming the same account simultaneously.  
**Decision**: Best-effort claim file with PID tracking and 60-second expiry, without file locking.  
**Rationale**: Claims are advisory, not authoritative. Stale claims self-expire, and zombie process detection (`process.kill(pid, 0)`) handles crashes. The cost of occasional double-claims is low compared to the complexity of distributed locking.  
**Consequences**: Rare duplicate claims possible; acceptable given the use case.

---

## 15. Architecture Governance

### 15.1 Automated Checks

| Check | Tool | Enforcement |
|-------|------|-------------|
| Type safety | TypeScript `--strict` with extra flags | CI: `bun run typecheck` |
| Runtime correctness | Vitest test suite | CI: `bun run test` |
| Build integrity | esbuild bundler + dist verification | CI: `test -f packages/*/dist/index.js` |
| Dependency direction | Workspace protocol (`workspace:^`) + tsconfig paths | Compile-time (TypeScript path resolution) |
| Schema-type consistency | Valibot `v.InferOutput` | Compile-time (types auto-derived) |

### 15.2 Consistency Mechanisms

- **Topological build order** ensures adapters build before plugins
- **CI concurrency** (`cancel-in-progress`) prevents stale results
- **`prepublishOnly`** script runs typecheck + build before npm publish
- **File permission enforcement** (0o600) on sensitive credential files

### 15.3 Missing Governance (Known Gaps)

- No linting configuration (ESLint/Biome)
- No formatting enforcement (Prettier/Biome)
- No pre-commit hooks
- No changelog/versioning automation (changesets)
- No dependency update automation (Renovate/Dependabot)
- No code coverage requirements

---

## 16. Blueprint for New Development

### 16.1 Development Workflow

**Starting a new provider plugin**:
1. Copy `packages/codex-multi-account` as template (it has native OAuth, no external deps)
2. Create adapter in `packages/oauth-adapters/src/new-provider.ts`
3. Update `constants.ts` to reference the new adapter
4. Implement `oauth.ts`, `request-transform.ts`, `runtime-factory.ts`, `usage.ts`
5. Wire up in `index.ts`
6. Run `bun run typecheck && bun run test && bun run build`

**Adding a feature to an existing plugin**:
1. Identify which layer the change belongs to (infrastructure vs. business logic)
2. Make the change in the correct module
3. If the change affects both plugins, apply to both (check for divergences)
4. Run full CI checks

### 16.2 Component Creation Checklist

- [ ] Schemas defined in `types.ts` with `v.InferOutput` types
- [ ] Constants derived from adapter in `constants.ts`
- [ ] No hardcoded magic values — use named constants
- [ ] Error handling follows Result type pattern (`{ ok: true/false }`)
- [ ] Disk writes go through `AccountStore` (never direct `fs.writeFile`)
- [ ] All `catch` blocks have explicit handling (not silently swallowed without comment)
- [ ] Toast notifications use `void showToast()` pattern (fire-and-forget)
- [ ] Debug logging gated by `config.debug` flag

### 16.3 Common Pitfalls

| Pitfall | Why It's Dangerous | Prevention |
|---------|--------------------|------------|
| Direct file writes bypassing `AccountStore` | Split-brain corruption in multi-process | All writes must go through `withFileLock` |
| Concurrent token refreshes for same account | Wasted API calls, potential race conditions | Use `refreshMutexByAccountId` map pattern |
| Blocking on toast notifications | Delays request flow | Always use `void showToast(...)` |
| Forgetting to `invalidate()` runtime after credential change | Stale tokens in cached runtime | Call `runtimeFactory.invalidate(uuid)` after any credential mutation |
| Adding new fields to `StoredAccount` without schema defaults | Existing storage files fail validation | Always use `v.optional(field, default)` for new fields |
| Breaking `opencode-anthropic-auth` compatibility | Anthropic plugin depends on internal API | Pin version and test with integration tests |
| SSE stream corruption from mid-line chunk boundaries | Broken JSON in streamed responses | Use line-buffered transform (`processCompleteLines`) |

### 16.4 Key Files to Understand First

For any new developer, read in this order:

1. `packages/oauth-adapters/src/types.ts` — The core interface contract
2. `packages/anthropic-multi-account/src/types.ts` — Schema and type definitions
3. `packages/anthropic-multi-account/src/index.ts` — How a plugin registers with OpenCode
4. `packages/anthropic-multi-account/src/executor.ts` — The request flow with rotation
5. `packages/anthropic-multi-account/src/account-manager.ts` — Account selection strategies

---

> **Maintenance Note**: This blueprint reflects the codebase as of 2026-02-11. Update this document when:
> - A new provider plugin is added
> - Shared modules are extracted into a core package
> - The plugin interface contract (`@opencode-ai/plugin`) changes
> - New cross-cutting concerns are implemented (e.g., metrics, distributed caching)
