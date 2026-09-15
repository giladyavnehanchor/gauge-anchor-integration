/// <reference types="@cloudflare/workers-types" />

import { HttpAnchorClient } from './anchor.js';
import {
  prepareDataForSlack,
  runGaugeContentWorkflow,
  sendGaugeContentToSlack,
} from './content-pipeline.js';
import { parseConfig } from './config.js';
import { runIdentityMonitor } from './monitor.js';
import { CloudflareKvStateStore } from './state.js';
import { SlackWebhookClient } from './slack.js';
import { HttpThumbnailClient } from './thumbnails.js';

interface WorkerEnv {
  ANCHOR_API_KEY: string;
  ANCHOR_API_BASE?: string;
  SLACK_WEBHOOK_URL?: string;
  SLACK_BOT_TOKEN?: string;
  SLACK_CHANNEL_ID?: string;
  SLACK_SIGNING_SECRET?: string;
  INTERNAL_API_TOKEN?: string;
  PORT?: string;
  GAUGE_APPLICATION_ID?: string;
  GAUGE_APPLICATION_NAME?: string;
  GAUGE_APPLICATION_URL?: string;
  GAUGE_IDENTITY_ID?: string;
  GAUGE_VALIDATION_TASK_NAME?: string;
  GAUGE_CONTENT_TASK_NAME?: string;
  GAUGE_PUBLISH_TASK_NAME?: string;
  SEARCH_CONSOLE_INDEX_TASK_NAME?: string;
  SEARCH_CONSOLE_APPLICATION_ID?: string;
  SEARCH_CONSOLE_APPLICATION_NAME?: string;
  SEARCH_CONSOLE_APPLICATION_URL?: string;
  SEARCH_CONSOLE_IDENTITY_ID?: string;
  SEARCH_CONSOLE_VALIDATION_TASK_NAME?: string;
  IDENTITY_USER_NAME?: string;
  REAUTH_AUTH_METHOD?: string;
  NOTIFY_RECOVERY?: string;
  DRY_RUN?: string;
  REQUEST_TIMEOUT_MS?: string;
  ANCHOR_REAUTH_TIMEOUT_MS?: string;
  ANCHOR_TASK_POLL_INTERVAL_MS?: string;
  ANCHOR_CONTENT_TASK_TIMEOUT_MS?: string;
  THUMBNAIL_TIMEOUT_MS?: string;
  THUMBNAIL_PROVIDER?: string;
  THUMBNAIL_MODEL?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  IDENTITY_MONITOR_STATE: KVNamespace;
}

export default {
  async scheduled(
    controller: ScheduledController,
    env: WorkerEnv,
  ): Promise<void> {
    const config = parseConfig(env);
    const anchor = new HttpAnchorClient(config);
    const slack = new SlackWebhookClient(config);
    const result = await runIdentityMonitor(config, {
      anchor,
      slack,
      state: new CloudflareKvStateStore(env.IDENTITY_MONITOR_STATE),
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
          thumbnails: new HttpThumbnailClient(config),
          log: (message, details) => console.log(message, details ?? ''),
        })
      : undefined;
    if (gaugeContent) {
      await sendGaugeContentToSlack(config, result, gaugeContent, {
        slack,
        log: (message, details) => console.log(message, details ?? ''),
      });
    }
    console.log('Identity monitor completed', controller.cron, {
      ...result,
      ...(gaugeContent ? { gaugeContent } : {}),
    });
  },
};
