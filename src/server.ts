import 'dotenv/config';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { HttpAnchorClient } from './anchor.js';
import {
  prepareDataForSlack,
  runGaugeContentWorkflow,
  sendGaugeContentToSlack,
} from './content-pipeline.js';
import { readNodeConfig } from './config.js';
import { NodeFileDraftStore } from './drafts.js';
import { ensureSearchConsoleIdentity, runIdentityMonitor } from './monitor.js';
import { indexWithGoogleSearchConsole, publishDraft } from './publish-pipeline.js';
import { NodeFileStateStore } from './state.js';
import { SlackWebhookClient } from './slack.js';
import type {
  DiscoveryDraft,
  GaugeContentMessage,
  MonitorRunResult,
  PublishDestination,
  PublishRequest,
} from './types.js';
import { HttpThumbnailClient } from './thumbnails.js';

const config = readNodeConfig();
if (!config.internalApiToken) {
  throw new Error('INTERNAL_API_TOKEN is required to run the Express server');
}
if (!config.slackSigningSecret) {
  throw new Error('SLACK_SIGNING_SECRET is required to handle Slack interactions');
}

const stateFile = process.env.NODE_STATE_FILE || 'state/identity-monitor.json';
const draftFile = process.env.NODE_DRAFT_FILE || 'state/discovery-drafts.json';
const thumbnailOutputDir = resolve(config.thumbnailOutputDir ?? 'state/thumbnails');
const anchor = new HttpAnchorClient(config);
const drafts = new NodeFileDraftStore(draftFile);
const slack = new SlackWebhookClient(
  config,
  fetch,
  console.log,
  async (filePath) => new Uint8Array(await readFile(filePath)),
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

const identityMonitorDependencies = {
  anchor,
  slack,
  state: new NodeFileStateStore(stateFile),
  log: (message: string, details?: Record<string, unknown>) =>
    console.log(message, details ?? ''),
};

const app = express();
app.disable('x-powered-by');

function requireApiToken(request: Request, response: Response, next: () => void): void {
  const authorization = request.header('authorization');
  if (authorization !== `Bearer ${config.internalApiToken}`) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function destination(value: unknown): PublishDestination {
  if (value === 'blogs' || value === 'templates hubs' || value === 'guides') return value;
  throw new Error('destination must be blogs, templates hubs, or guides');
}

function parsePublishRequest(value: unknown): PublishRequest {
  const body = record(value);
  if (
    typeof body.draftId !== 'string' ||
    typeof body.thumbnailPath !== 'string'
  ) {
    throw new Error('draftId and thumbnailPath are required');
  }
  return {
    draftId: body.draftId,
    ticketUrl: typeof body.ticketUrl === 'string' ? body.ticketUrl : '',
    articleTitle: typeof body.articleTitle === 'string' ? body.articleTitle : '',
    articleSummary: typeof body.articleSummary === 'string' ? body.articleSummary : '',
    thumbnailPath: body.thumbnailPath,
    destination: destination(body.destination),
  };
}

function parsePublishBody(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const contentType = request.header('content-type') ?? '';
  const parser = contentType.includes('application/x-www-form-urlencoded')
    ? express.raw({ type: 'application/x-www-form-urlencoded' })
    : express.json({ limit: '1mb' });
  parser(request, response, next);
}

function draftMessage(draft: DiscoveryDraft): GaugeContentMessage {
  return {
    target: config.targets.find(({ key }) => key === 'gauge') ?? {
      key: 'gauge',
      label: 'Gauge',
      applicationName: 'Gauge',
      applicationUrl: 'https://app.withgauge.com',
    },
    application: draft.application,
    result: draft.content,
    thumbnails: draft.thumbnails,
    draftId: draft.id,
    ...(draft.selectedThumbnailIndex !== undefined
      ? { selectedThumbnailIndex: draft.selectedThumbnailIndex }
      : {}),
    ...(draft.selectedDestination ? { destination: draft.selectedDestination } : {}),
  };
}

async function discover(): Promise<{
  monitor: MonitorRunResult;
  draft?: DiscoveryDraft;
}> {
  const monitor = await runIdentityMonitor(config, identityMonitorDependencies, {
    validateIdentities: (key) => key === 'gauge',
  });
  const gauge = monitor.targets.find(({ target }) => target === 'gauge');
  const searchConsole = monitor.targets.find(
    ({ target }) => target === 'search-console',
  );
  if (!gauge || gauge.condition !== 'healthy' || !gauge.identityId) {
    return { monitor };
  }

  const content = await runGaugeContentWorkflow(config, monitor, {
    anchor,
    log: (message, details) => console.log(message, details ?? ''),
  });
  if (!content) return { monitor };

  const prepared = await prepareDataForSlack(config, content, {
    thumbnails,
    log: (message, details) => console.log(message, details ?? ''),
  });

  const draft: DiscoveryDraft = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    application: gauge.application,
    content: prepared.result,
    applicationId: gauge.applicationId,
    identityId: gauge.identityId,
    searchConsoleApplicationId: searchConsole?.applicationId ?? '',
    searchConsoleIdentityId: searchConsole?.identityId ?? '',
    ticketUrl: prepared.result.ticketUrl,
    articleTitle: prepared.result.articleTitle,
    articleSummary: prepared.result.articleSummary,
    thumbnails: prepared.thumbnails,
    status: 'ready',
  };
  await drafts.put(draft);
  await sendGaugeContentToSlack(config, monitor, prepared, {
    slack,
    draftId: draft.id,
    log: (message, details) => console.log(message, details ?? ''),
  });
  return { monitor, draft };
}

function verifySlackSignature(request: Request): boolean {
  const timestamp = request.header('x-slack-request-timestamp');
  const signature = request.header('x-slack-signature');
  if (!timestamp || !signature || !Buffer.isBuffer(request.body)) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const base = `v0:${timestamp}:${request.body.toString('utf8')}`;
  const expected = `v0=${createHmac('sha256', config.slackSigningSecret as string)
    .update(base)
    .digest('hex')}`;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);
  return (
    expectedBuffer.length === actualBuffer.length &&
    timingSafeEqual(expectedBuffer, actualBuffer)
  );
}

app.post('/discover', express.json({ limit: '1mb' }), requireApiToken, async (_request, response) => {
  try {
    response.json(await discover());
  } catch (error) {
    console.error('Discovery request failed', error);
    response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post('/publish', parsePublishBody, async (request, response) => {
  if (!Buffer.isBuffer(request.body)) {
    if (request.header('authorization') !== `Bearer ${config.internalApiToken}`) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }
    try {
      const publishRequest = parsePublishRequest(request.body);
      if (!publishRequest.draftId) {
        throw new Error('draftId is required for an idempotent publish');
      }
      const searchConsole = await ensureSearchConsoleIdentity(
        config,
        identityMonitorDependencies,
      );
      const articleUrl = await publishDraft(config, publishRequest, {
        anchor,
        drafts,
        thumbnailOutputDir,
        log: (message, details) => console.log(message, details ?? ''),
      });
      const result = await indexWithGoogleSearchConsole(
        config,
        publishRequest.draftId,
        articleUrl,
        {
          anchor,
          drafts,
          searchConsoleApplicationId: searchConsole.applicationId,
          searchConsoleIdentityId: searchConsole.identityId,
          log: (message, details) => console.log(message, details ?? ''),
        },
      );
      response.json(result);
    } catch (error) {
      console.error('Publish request failed', error);
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

    if (!verifySlackSignature(request)) {
      response.status(401).send('Invalid Slack signature');
      return;
    }
    try {
      const params = new URLSearchParams(request.body.toString('utf8'));
      const payload = record(JSON.parse(params.get('payload') ?? '{}'));
      const actions = Array.isArray(payload.actions) ? payload.actions : [];
      const action = record(actions[0]);
      const channel = record(payload.channel);
      const actionId = typeof action.action_id === 'string' ? action.action_id : '';
      const actionValue = record(JSON.parse(typeof action.value === 'string' ? action.value : '{}'));
      const channelId = typeof channel.id === 'string' ? channel.id : '';
      if (actionId === 'run-discovery') {
        if (!channelId) throw new Error('Slack interaction lacks channel ID');
        response.json({
          response_type: 'ephemeral',
          text: 'Discovery started. I will post the result in this channel.',
        });
        void discover()
          .then(async (result) => {
            const gauge = result.monitor.targets.find(({ target }) => target === 'gauge');
            const searchConsole = result.monitor.targets.find(
              ({ target }) => target === 'search-console',
            );
            const draftText = result.draft
              ? ` Draft created for "${result.draft.articleTitle}".`
              : ' No discovery draft was created.';
            await slack.sendChannelText(
              channelId,
              `Discovery finished. Gauge: ${gauge?.condition ?? 'unknown'}. Search Console: ${
                searchConsole?.condition ?? 'unknown'
              }.${draftText}`,
            );
          })
          .catch(async (error) => {
            await slack.sendChannelText(
              channelId,
              `Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
            ).catch((notificationError) =>
              console.error('Slack discovery failure notification failed', notificationError),
            );
          });
        return;
      }

      const message = record(payload.message);
      const user = record(payload.user);
      const blockId = typeof action.block_id === 'string' ? action.block_id : '';
      const draftId =
        typeof actionValue.draftId === 'string'
          ? actionValue.draftId
          : actionId === 'destination-select' && blockId.startsWith('destination-selection:')
            ? blockId.slice('destination-selection:'.length)
            : '';
      const draft = draftId ? await drafts.get(draftId) : undefined;
      if (!draft) throw new Error('Discovery draft was not found');
      const messageTs = typeof message.ts === 'string' ? message.ts : '';
      if (!channelId || !messageTs) throw new Error('Slack interaction lacks channel or message ID');

      if (actionId.startsWith('thumbnail-select-')) {
        const index = Number(actionValue.index);
        if (!Number.isInteger(index) || index < 0 || index >= draft.thumbnails.length) {
          throw new Error('Invalid thumbnail selection');
        }
        const updated = { ...draft, selectedThumbnailIndex: index };
        await drafts.put(updated);
        await slack.updateGaugeContentMessage(channelId, messageTs, draftMessage(updated));
        response.json({ response_type: 'ephemeral', text: `Selected thumbnail ${index + 1}.` });
        return;
      }

      if (actionId === 'destination-select') {
        const selected = destination(action.selected_option && record(action.selected_option).value);
        const updated = { ...draft, selectedDestination: selected };
        await drafts.put(updated);
        await slack.updateGaugeContentMessage(channelId, messageTs, draftMessage(updated));
        response.json({ response_type: 'ephemeral', text: `Selected destination: ${selected}.` });
        return;
      }

      if (actionId === 'publish-article') {
        if (
          draft.selectedThumbnailIndex === undefined ||
          !draft.selectedDestination
        ) {
          response.json({
            response_type: 'ephemeral',
            text: 'Choose a thumbnail and destination before posting.',
          });
          return;
        }
        response.json({
          response_type: 'ephemeral',
          text: `Publishing started for <@${typeof user.id === 'string' ? user.id : ''}>.`,
        });
        const thumbnail = draft.thumbnails[draft.selectedThumbnailIndex];
        if (!thumbnail?.filePath) throw new Error('Selected thumbnail has no server-side file');
        const publishRequest = {
          draftId: draft.id,
          ticketUrl: draft.ticketUrl,
          articleTitle: draft.articleTitle,
          articleSummary: draft.articleSummary,
          thumbnailPath: thumbnail.filePath,
          destination: draft.selectedDestination,
        };
        void ensureSearchConsoleIdentity(config, identityMonitorDependencies)
          .then(async (searchConsole) => {
            const articleUrl = await publishDraft(config, publishRequest, {
              anchor,
              drafts,
              thumbnailOutputDir,
              log: (logMessage, details) => console.log(logMessage, details ?? ''),
            });
            return indexWithGoogleSearchConsole(config, draft.id, articleUrl, {
              anchor,
              drafts,
              searchConsoleApplicationId: searchConsole.applicationId,
              searchConsoleIdentityId: searchConsole.identityId,
              log: (logMessage, details) => console.log(logMessage, details ?? ''),
            });
          }).then(async (result) => {
          await slack.sendChannelText(
            channelId,
            `Published <${result.articleUrl}|${draft.articleTitle}>. Search indexing: ${result.indexingMessage}`,
          );
        }).catch(async (error) => {
          await slack.sendChannelText(
            channelId,
            `Publishing failed for ${draft.articleTitle}: ${error instanceof Error ? error.message : String(error)}`,
          ).catch((notificationError) => console.error('Slack publish failure notification failed', notificationError));
        });
        return;
      }
      response.status(400).json({ error: 'Unsupported Slack action' });
    } catch (error) {
      console.error('Slack interaction failed', error);
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
});

app.listen(config.port, () => {
  console.log(`Express server listening on port ${config.port}`);
});
