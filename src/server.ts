import 'dotenv/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { createApp } from './app.js';
import { resumeAutoPublish } from './auto-publish.js';
import { discover } from './discover.js';
import { publish } from './publish.js';
import { handleSlackInteraction, parseDestination, record } from './slack-interactions.js';

const app = createApp();
const { internalApiToken, slackSigningSecret, port } = app.config;
if (!internalApiToken) throw new Error('INTERNAL_API_TOKEN is required to run the server');
if (!slackSigningSecret) throw new Error('SLACK_SIGNING_SECRET is required to handle Slack interactions');

const server = express();
server.disable('x-powered-by');

function hasApiToken(request: Request): boolean {
  return request.header('authorization') === `Bearer ${internalApiToken}`;
}

function requireApiToken(request: Request, response: Response, next: NextFunction): void {
  if (!hasApiToken(request)) {
    response.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function hasValidSlackSignature(request: Request): boolean {
  const timestamp = request.header('x-slack-request-timestamp');
  const signature = request.header('x-slack-signature');
  if (!timestamp || !signature || !Buffer.isBuffer(request.body)) return false;
  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(ageSeconds) || ageSeconds > 300) return false;
  const expected = `v0=${createHmac('sha256', slackSigningSecret as string)
    .update(`v0:${timestamp}:${request.body.toString('utf8')}`)
    .digest('hex')}`;
  return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

server.get('/health', (_request, response) => {
  response.json({ status: 'ok' });
});

server.post('/discover', express.json({ limit: '1mb' }), requireApiToken, async (_request, response) => {
  try {
    response.json({ draft: await discover(app) });
  } catch (error) {
    console.error('Discovery request failed', error);
    response.status(500).json({ error: errorText(error) });
  }
});

const slackInteractions = express.Router();
slackInteractions.use(express.raw({ type: 'application/x-www-form-urlencoded' }));
slackInteractions.use(async (request, response) => {
  if (!hasValidSlackSignature(request)) {
    response.status(401).send('Invalid Slack signature');
    return;
  }
  try {
    const params = new URLSearchParams(request.body.toString('utf8'));
    const payload = record(JSON.parse(params.get('payload') ?? '{}'));
    response.json(await handleSlackInteraction(app, payload));
  } catch (error) {
    console.error('Slack interaction failed', error);
    response.status(400).json({ error: errorText(error) });
  }
});

server.post('/slack', slackInteractions);

// Slack's interactivity URL points at /publish; form-encoded posts there are Slack callbacks.
server.post(
  '/publish',
  (request, response, next) =>
    request.is('application/x-www-form-urlencoded') ? slackInteractions(request, response, next) : next(),
  express.json({ limit: '1mb' }),
  requireApiToken,
  async (request, response) => {
    try {
      const body = record(request.body);
      if (typeof body.draftId !== 'string' || typeof body.thumbnailPath !== 'string') {
        throw new Error('draftId and thumbnailPath are required');
      }
      response.json(await publish(app, body.draftId, {
        thumbnailPath: body.thumbnailPath,
        destination: parseDestination(body.destination),
      }));
    } catch (error) {
      console.error('Publish request failed', error);
      response.status(400).json({ error: errorText(error) });
    }
  },
);

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
  resumeAutoPublish(app).catch((error) => console.error('Resuming auto-publish countdowns failed', error));
});
