import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageRoot = dirname(__dirname);

export const bundledTemplatePath = join(packageRoot, "src", "fingerprint-data.json");

export async function loadBundledFingerprint() {
  return JSON.parse(await readFile(bundledTemplatePath, "utf8"));
}
