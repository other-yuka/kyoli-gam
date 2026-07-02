import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { ModelCapability, ModelInfo, ProviderId } from "@kyoli-gam/core";
import { bundledModelsDevSnapshot } from "./bundled-snapshot";

const DEFAULT_MODELS_DEV_URL = "https://models.dev";
const DEFAULT_REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 10 * 1000;

type ModelsDevProviderId = "openai" | "anthropic";

interface ModelsDevSourceOptions {
  sourceUrl: string;
  cachePath: string;
  localPath?: string;
  disableFetch: boolean;
  refreshIntervalMs: number;
  fetchTimeoutMs: number;
}

type ModelsDevPayload = Record<
  string,
  {
    id?: string;
    name?: string;
    models?: Record<string, ModelsDevModel>;
  }
>;

interface ModelsDevModel {
  id?: string;
  name?: string;
  family?: string;
  attachment?: boolean;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: Record<string, unknown> | string[];
  capabilities?: Record<string, unknown> | string[];
  [key: string]: unknown;
}

export class ModelsDevRegistrySource {
  private payload?: ModelsDevPayload;
  private refreshPromise?: Promise<void>;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: ModelsDevSourceOptions) {}

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ModelsDevRegistrySource {
    return new ModelsDevRegistrySource({
      sourceUrl: normalizeSourceUrl(env.KYOLI_MODELS_URL ?? DEFAULT_MODELS_DEV_URL),
      cachePath: env.KYOLI_MODELS_CACHE_PATH ?? defaultCachePath(),
      localPath: env.KYOLI_MODELS_PATH,
      disableFetch: env.KYOLI_DISABLE_MODELS_FETCH === "true",
      refreshIntervalMs: readDurationMs(
        env.KYOLI_MODELS_REFRESH_INTERVAL_MS,
        DEFAULT_REFRESH_INTERVAL_MS,
      ),
      fetchTimeoutMs: readDurationMs(
        env.KYOLI_MODELS_FETCH_TIMEOUT_MS,
        DEFAULT_FETCH_TIMEOUT_MS,
      ),
    });
  }

  async listModels(enabledProviders: ProviderId[]): Promise<ModelInfo[]> {
    await this.ensureLoaded();

    const providerIds = enabledProviders
      .map(toModelsDevProviderId)
      .filter((providerId): providerId is ModelsDevProviderId => Boolean(providerId));
    if (providerIds.length === 0 || !this.payload) return [];

    return providerIds.flatMap((providerId) =>
      mapProviderModels(providerId, this.payload?.[providerId]?.models ?? {}),
    );
  }

  startAutoRefresh(): void {
    void this.ensureLoaded().then(() => this.refreshInBackground());

    if (this.refreshTimer) return;
    this.refreshTimer = setInterval(() => {
      this.refreshInBackground();
    }, this.options.refreshIntervalMs);
    this.refreshTimer.unref?.();
  }

  stopAutoRefresh(): void {
    if (!this.refreshTimer) return;
    clearInterval(this.refreshTimer);
    this.refreshTimer = undefined;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.payload) return;

    this.payload =
      (await this.readLocalOverride()) ??
      (await this.readCache()) ??
      bundledModelsDevSnapshot;
  }

  private refreshInBackground(): void {
    if (this.options.disableFetch || this.options.localPath) return;
    if (this.refreshPromise) return;

    this.refreshPromise = this.fetchRemote()
      .then((payload) => {
        this.payload = payload;
        return this.writeCache(payload);
      })
      .catch(() => undefined)
      .finally(() => {
        this.refreshPromise = undefined;
      });
  }

  private async readLocalOverride(): Promise<ModelsDevPayload | undefined> {
    if (!this.options.localPath) return undefined;
    return readJsonFile(this.options.localPath);
  }

  private async readCache(): Promise<ModelsDevPayload | undefined> {
    return readJsonFile(this.options.cachePath);
  }

  private async writeCache(payload: ModelsDevPayload): Promise<void> {
    await mkdir(dirname(this.options.cachePath), { recursive: true });
    await writeFile(this.options.cachePath, JSON.stringify(payload), "utf8");
  }

  private async fetchRemote(): Promise<ModelsDevPayload> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.fetchTimeoutMs);
    timeout.unref?.();

    try {
      const response = await fetch(`${this.options.sourceUrl}/api.json`, {
        signal: controller.signal,
        headers: {
          accept: "application/json",
          "user-agent": "kyoli-gam/0.0.0",
        },
      });

      if (!response.ok) {
        throw new Error(`models.dev fetch failed with ${response.status}`);
      }

      return (await response.json()) as ModelsDevPayload;
    } finally {
      clearTimeout(timeout);
    }
  }
}

function mapProviderModels(
  providerId: ModelsDevProviderId,
  models: Record<string, ModelsDevModel>,
): ModelInfo[] {
  const kyoliProvider = toKyoliProviderId(providerId);
  const publicProvider = toPublicProviderId(providerId);
  return Object.entries(models).flatMap(([modelId, model]) => {
    const upstreamId = model.id ?? modelId;
    if (isSuspendedModelsDevModel(providerId, upstreamId)) {
      return [];
    }
    return {
      id: `${publicProvider}/${modelId}`,
      provider: kyoliProvider,
      upstreamId,
      displayName: model.name ?? modelId,
      aliases: buildModelAliases(providerId, upstreamId),
      capabilities: inferCapabilities(providerId, model),
      metadata: pickModelMetadata(model),
    };
  });
}

function isSuspendedModelsDevModel(
  providerId: ModelsDevProviderId,
  upstreamId: string,
): boolean {
  if (providerId !== "anthropic") return false;
  const suspendedFamilies = readSuspendedClaudeFamilies();
  return suspendedFamilies.has("fable") && upstreamId.toLowerCase().includes("fable");
}

function readSuspendedClaudeFamilies(): Set<string> {
  const raw = process.env.KYOLI_SUSPENDED_CLAUDE_CODE_FAMILIES
    ?? process.env.KYOLI_SUSPENDED_CLAUDE_MODELS
    ?? "";
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  );
}

function buildModelAliases(providerId: ModelsDevProviderId, upstreamId: string): string[] {
  const kyoliProvider = toKyoliProviderId(providerId);
  const publicProvider = toPublicProviderId(providerId);
  const aliases = [
    upstreamId,
    `${kyoliProvider}/${upstreamId}`,
  ];

  if (providerId === "anthropic" && upstreamId === "claude-fable-5") {
    aliases.push(
      "fable",
      `${kyoliProvider}/fable`,
      `${publicProvider}/fable`,
    );
  }

  return [...new Set(aliases)];
}

function pickModelMetadata(model: ModelsDevModel): Record<string, unknown> | undefined {
  const metadata: Record<string, unknown> = {};
  for (const key of [
    "additional_speed_tiers",
    "service_tiers",
    "availability_nux",
    "upgrade",
    "max_context_window",
    "auto_compact_token_limit",
    "effective_context_window_percent",
    "experimental_supported_tools",
  ]) {
    const value = model[key];
    if (value !== undefined) {
      metadata[key] = value;
    }
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function toKyoliProviderId(providerId: ModelsDevProviderId): ProviderId {
  return providerId === "openai" ? "codex" : "claude-code";
}

function toPublicProviderId(providerId: ModelsDevProviderId): "openai" | "anthropic" {
  return providerId;
}

function inferCapabilities(
  providerId: ModelsDevProviderId,
  model: ModelsDevModel,
): ModelCapability[] {
  const capabilities = new Set<ModelCapability>(["streaming"]);

  if (providerId === "openai") {
    capabilities.add("responses");
    capabilities.add("chat");
    if (isCodexModel(model)) {
      capabilities.add("codex");
    }
  }

  if (providerId === "anthropic") {
    capabilities.add("messages");
  }

  if (hasCapability(model, "tool_call") || hasCapability(model, "tools")) {
    capabilities.add("tools");
  }

  if (hasCapability(model, "reasoning") || hasCapability(model, "thinking")) {
    capabilities.add("reasoning");
  }

  return [...capabilities];
}

function isCodexModel(model: ModelsDevModel): boolean {
  const id = typeof model.id === "string" ? model.id.toLowerCase() : "";
  const name = typeof model.name === "string" ? model.name.toLowerCase() : "";
  const family = typeof model.family === "string" ? model.family.toLowerCase() : "";
  return id.includes("codex") || name.includes("codex") || family.includes("codex");
}

function hasCapability(model: ModelsDevModel, capability: string): boolean {
  const direct = model[capability];
  if (direct === true) return true;

  const capabilities = model.capabilities;
  if (Array.isArray(capabilities)) return capabilities.includes(capability);
  if (capabilities && typeof capabilities === "object") {
    return (capabilities as Record<string, unknown>)[capability] === true;
  }

  return false;
}

async function readJsonFile(path: string): Promise<ModelsDevPayload | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ModelsDevPayload;
  } catch {
    return undefined;
  }
}

function toModelsDevProviderId(providerId: ProviderId): ModelsDevProviderId | undefined {
  if (providerId === "codex") return "openai";
  if (providerId === "claude-code") return "anthropic";
  return undefined;
}

function normalizeSourceUrl(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function readDurationMs(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultCachePath(): string {
  const cacheHome = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  return join(cacheHome, "kyoli-gam", "models.dev.json");
}
