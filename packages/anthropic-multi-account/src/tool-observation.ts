import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "./utils";

const OBSERVED_TOOL_FILE = "anthropic-observed-tools.json";
const FILE_MODE = 0o600;

type ObservedToolEntry = {
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type ObservedToolInventory = {
  observedTools: Record<string, ObservedToolEntry>;
};

function getObservedToolPath(): string {
  return join(getConfigDir(), OBSERVED_TOOL_FILE);
}

async function loadObservedToolInventory(): Promise<ObservedToolInventory> {
  try {
    const content = await fs.readFile(getObservedToolPath(), "utf8");
    const parsed = JSON.parse(content) as ObservedToolInventory;
    return typeof parsed === "object" && parsed && typeof parsed.observedTools === "object"
      ? parsed
      : { observedTools: {} };
  } catch {
    return { observedTools: {} };
  }
}

async function saveObservedToolInventory(inventory: ObservedToolInventory): Promise<void> {
  const targetPath = getObservedToolPath();
  await fs.mkdir(dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, `${JSON.stringify(inventory, null, 2)}\n`, { mode: FILE_MODE });
  await fs.chmod(targetPath, FILE_MODE).catch(() => {});
}

export async function readObservedToolInventory(): Promise<ObservedToolInventory> {
  return loadObservedToolInventory();
}

export async function recordObservedToolNames(toolNames: string[]): Promise<void> {
  if (toolNames.length === 0) {
    return;
  }

  const inventory = await loadObservedToolInventory();
  const now = new Date().toISOString();

  for (const toolName of toolNames) {
    const entry = inventory.observedTools[toolName];
    if (!entry) {
      inventory.observedTools[toolName] = {
        count: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      continue;
    }

    entry.count += 1;
    entry.lastSeenAt = now;
  }

  await saveObservedToolInventory(inventory);
}
