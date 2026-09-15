import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HttpAnchorClient } from './anchor.js';
import {
  prepareDataForSlack,
  runGaugeContentWorkflow,
  sendGaugeContentToSlack,
} from './content-pipeline.js';
import { readNodeConfig } from './config.js';
import { runIdentityMonitor } from './monitor.js';
import { NodeFileStateStore } from './state.js';
import { SlackWebhookClient } from './slack.js';
import { HttpThumbnailClient } from './thumbnails.js';

let running = false;

async function runOnce(): Promise<void> {
  if (running) {
    console.warn('Identity monitor is already running; skipping overlapping invocation');
    return;
  }
  running = true;
  try {
    const config = readNodeConfig();
    console.log('Identity/content run started', {
      dryRun: config.dryRun,
      thumbnailProvider: config.thumbnailProvider ?? 'not configured',
      thumbnailModel: config.thumbnailModel ?? 'provider default',
      thumbnailTimeoutMs: config.thumbnailTimeoutMs ?? config.requestTimeoutMs,
      targetCount: config.targets.length,
    });
    const stateFile = process.env.NODE_STATE_FILE || 'state/identity-monitor.json';
    const anchor = new HttpAnchorClient(config);
    const slack = new SlackWebhookClient(
      config,
      fetch,
      console.log,
      async (filePath) => new Uint8Array(await readFile(filePath)),
    );
    const thumbnailOutputDir = resolve(
      config.thumbnailOutputDir ?? 'state/thumbnails',
    );
    const thumbnails = new HttpThumbnailClient(
      config,
      fetch,
      async (fileName, data) => {
        await mkdir(thumbnailOutputDir, { recursive: true });
        const filePath = resolve(thumbnailOutputDir, fileName);
        await writeFile(filePath, Buffer.from(data, 'base64'));
        return filePath;
      },
    );
    const result = await runIdentityMonitor(config, {
      anchor,
      slack,
      state: new NodeFileStateStore(stateFile),
      log: (message, details) => console.log(message, details ?? ''),
    }, {
      validateIdentities: (key) => key === 'gauge',
    });
    const content = await runGaugeContentWorkflow(config, result, {
      anchor,
      log: (message, details) => console.log(message, details ?? ''),
    });
    const gaugeContent = content
      ? await prepareDataForSlack(config, content, {
          thumbnails,
          log: (message, details) => console.log(message, details ?? ''),
        })
      : undefined;
    if (gaugeContent) {
      await sendGaugeContentToSlack(config, result, gaugeContent, {
        slack,
        log: (message, details) => console.log(message, details ?? ''),
      });
    }
    console.log(JSON.stringify({
      ...result,
      ...(gaugeContent ? { gaugeContent } : {}),
    }));
  } finally {
    running = false;
  }
}

async function main(): Promise<void> {
  const watch = process.argv.includes('--watch');
  if (!watch) {
    await runOnce();
    return;
  }

  const intervalMs = Number(process.env.RUN_INTERVAL_MS || 172_800_000);
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
    throw new Error('RUN_INTERVAL_MS must be an integer of at least 1000 milliseconds');
  }
  await runOnce();
  setInterval(() => {
    runOnce().catch((error) => {
      console.error(
        'Identity/content run failed',
        error instanceof Error ? error.stack ?? error.message : error,
      );
    });
  }, intervalMs);
}

main().catch((error) => {
  console.error(
    'Identity/content run failed',
    error instanceof Error ? error.stack ?? error.message : error,
  );
  process.exitCode = 1;
});
