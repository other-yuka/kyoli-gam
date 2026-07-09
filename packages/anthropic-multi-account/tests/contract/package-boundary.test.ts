import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

async function listTsFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listTsFiles(path);
    return entry.isFile() && path.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

describe("package boundaries", () => {
  test("plugin source imports Claude Code helpers through public provider seams", async () => {
    const files = await listTsFiles(join(dirname(fileURLToPath(import.meta.url)), "../../src"));
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(file, "utf8");
      if (source.includes("providers/claude-code/src")) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});
