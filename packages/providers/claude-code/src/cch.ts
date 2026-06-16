/** Claude Code request-integrity hash (`cch`) helpers.
 *
 * Claude Code writes a 5-hex `cch` token into the billing system block. For
 * versions whose seed has been verified, Kyoli stamps the deterministic value
 * over the placeholder after the final outbound body has been assembled. For
 * unknown or rotated seeds we deliberately leave the existing placeholder in
 * place rather than emitting a confident-but-wrong deterministic hash.
 */

export const CCH_SEEDS: Record<string, bigint> = {
  "2.1.177": 0x4d659218e32a3268n,
  // 2.1.178 was checked during the issue #91 review; the 2.1.177 seed did
  // not reproduce the captured cch, so leave it unstamped until a new seed is
  // independently extracted and verified.
};

const MASK = 0xfffffn;
const U64 = (1n << 64n) - 1n;
const P1 = 0x9e3779b185ebca87n;
const P2 = 0xc2b2ae3d27d4eb4fn;
const P3 = 0x165667b19e3779f9n;
const P4 = 0x85ebca77c2b2ae63n;
const P5 = 0x27d4eb2f165667c5n;
const BILLING_HEADER_PREFIX = "x-anthropic-billing-header:";
const CCH_RE = /(cc_entrypoint=[a-z0-9-]{1,32}; cch=)[0-9a-fA-F]{5}(?=;)/;
const CC_VERSION_RE = /\bcc_version=([0-9]+(?:\.[0-9]+){2})(?:\.[0-9a-f]+)?;/;

function rotl(value: bigint, bits: bigint): bigint {
  return ((value << bits) | (value >> (64n - bits))) & U64;
}

function round(accumulator: bigint, input: bigint): bigint {
  let next = (accumulator + input * P2) & U64;
  next = rotl(next, 31n);
  return (next * P1) & U64;
}

function mergeRound(accumulator: bigint, value: bigint): bigint {
  const rounded = round(0n, value);
  const next = (accumulator ^ rounded) & U64;
  return (next * P1 + P4) & U64;
}

export function xxh64(data: Uint8Array, seed: bigint): bigint {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const length = data.length;
  let offset = 0;
  let hash: bigint;

  if (length >= 32) {
    let v1 = (seed + P1 + P2) & U64;
    let v2 = (seed + P2) & U64;
    let v3 = seed & U64;
    let v4 = (seed - P1) & U64;
    const limit = length - 32;

    while (offset <= limit) {
      v1 = round(v1, view.getBigUint64(offset, true));
      offset += 8;
      v2 = round(v2, view.getBigUint64(offset, true));
      offset += 8;
      v3 = round(v3, view.getBigUint64(offset, true));
      offset += 8;
      v4 = round(v4, view.getBigUint64(offset, true));
      offset += 8;
    }

    hash = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & U64;
    hash = mergeRound(hash, v1);
    hash = mergeRound(hash, v2);
    hash = mergeRound(hash, v3);
    hash = mergeRound(hash, v4);
  } else {
    hash = (seed + P5) & U64;
  }

  hash = (hash + BigInt(length)) & U64;

  while (offset + 8 <= length) {
    const k1 = round(0n, view.getBigUint64(offset, true));
    hash = (hash ^ k1) & U64;
    hash = (rotl(hash, 27n) * P1 + P4) & U64;
    offset += 8;
  }

  if (offset + 4 <= length) {
    hash = (hash ^ ((BigInt(view.getUint32(offset, true)) * P1) & U64)) & U64;
    hash = (rotl(hash, 23n) * P2 + P3) & U64;
    offset += 4;
  }

  while (offset < length) {
    hash = (hash ^ ((BigInt(data[offset] ?? 0) * P5) & U64)) & U64;
    hash = (rotl(hash, 11n) * P1) & U64;
    offset += 1;
  }

  hash = (hash ^ (hash >> 33n)) & U64;
  hash = (hash * P2) & U64;
  hash = (hash ^ (hash >> 29n)) & U64;
  hash = (hash * P3) & U64;
  hash = (hash ^ (hash >> 32n)) & U64;
  return hash;
}

function replaceBillingCch(
  body: Record<string, unknown>,
  cch: string,
): { replaced: boolean; version?: string } {
  const system = body.system;
  if (!Array.isArray(system)) return { replaced: false };

  for (const entry of system) {
    if (!entry || typeof entry !== "object") continue;
    const systemEntry = entry as { text?: unknown };
    if (typeof systemEntry.text !== "string") continue;
    if (!systemEntry.text.startsWith(BILLING_HEADER_PREFIX)) continue;
    if (!CCH_RE.test(systemEntry.text)) continue;

    const version = CC_VERSION_RE.exec(systemEntry.text)?.[1];
    systemEntry.text = systemEntry.text.replace(CCH_RE, (_match, prefix: string) => `${prefix}${cch}`);
    return { replaced: true, version };
  }

  return { replaced: false };
}

function cchMaterial(bodyText: string): { bytes: Uint8Array; version?: string } | null {
  const body = JSON.parse(bodyText) as Record<string, unknown>;
  const { replaced, version } = replaceBillingCch(body, "00000");
  if (!replaced) return null;
  body.model = "";
  delete body.fallbacks;
  delete body.fallback_credit_token;
  delete body.max_tokens;
  return { bytes: new TextEncoder().encode(JSON.stringify(body)), version };
}

export function cchWithSeed(bodyText: string, seed: bigint): string | null {
  let material: { bytes: Uint8Array; version?: string } | null;
  try {
    material = cchMaterial(bodyText);
  } catch {
    return null;
  }
  if (!material) return null;
  const hash = xxh64(material.bytes, seed) & MASK;
  return hash.toString(16).padStart(5, "0");
}

export function cchForBody(bodyText: string, version?: string): string | null {
  let material: { bytes: Uint8Array; version?: string } | null;
  try {
    material = cchMaterial(bodyText);
  } catch {
    return null;
  }
  if (!material) return null;

  const seed = CCH_SEEDS[material.version ?? version ?? ""];
  if (seed === undefined) return null;
  const hash = xxh64(material.bytes, seed) & MASK;
  return hash.toString(16).padStart(5, "0");
}

export function stampClaudeCodeCch(bodyText: string, version?: string): string {
  const cch = cchForBody(bodyText, version);
  if (cch === null) return bodyText;
  try {
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const { replaced } = replaceBillingCch(body, cch);
    return replaced ? JSON.stringify(body) : bodyText;
  } catch {
    return bodyText;
  }
}
