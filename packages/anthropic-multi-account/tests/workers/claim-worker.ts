import { readClaims, writeClaim } from "../../src/claims";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function main(): Promise<void> {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  const accountId = process.argv[2] || process.env.ACCOUNT_ID;
  const writeDelayRaw = process.env.CLAIM_WRITE_DELAY_MS;
  const writeDelay = writeDelayRaw ? Number(writeDelayRaw) : 0;
  const holdRaw = process.env.CLAIM_HOLD_MS;
  const holdMs = holdRaw ? Number(holdRaw) : 0;

  if (
    !configDir
    || !accountId
    || !Number.isFinite(writeDelay)
    || writeDelay < 0
    || !Number.isFinite(holdMs)
    || holdMs < 0
  ) {
    process.exit(1);
  }

  process.env.OPENCODE_CONFIG_DIR = configDir;
  await wait(writeDelay);
  await writeClaim(accountId);
  await wait(100);
  const claims = await readClaims();
  process.stdout.write(JSON.stringify(claims));
  await wait(holdMs);
}

try {
  await main();
  process.exit(0);
} catch {
  process.exit(1);
}
