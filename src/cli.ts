import 'dotenv/config';
import { createApp } from './app.js';
import { discover } from './discover.js';

let running = false;

async function runOnce(): Promise<void> {
  if (running) {
    console.warn('Discovery is already running; skipping overlapping invocation');
    return;
  }
  running = true;
  try {
    const draft = await discover(createApp());
    console.log(JSON.stringify({ draft: draft ?? null }));
  } finally {
    running = false;
  }
}

function logFailure(error: unknown): void {
  console.error('Discovery failed', error instanceof Error ? error.stack ?? error.message : error);
}

async function main(): Promise<void> {
  if (!process.argv.includes('--watch')) {
    await runOnce();
    return;
  }
  const intervalMs = Number(process.env.RUN_INTERVAL_MS || 172_800_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error('RUN_INTERVAL_MS must be an integer of at least 1000 milliseconds');
  }
  await runOnce();
  setInterval(() => runOnce().catch(logFailure), intervalMs);
}

main().catch((error) => {
  logFailure(error);
  process.exitCode = 1;
});
