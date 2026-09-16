import { resolve } from 'node:path';
import type { Config, TargetConfig, TargetKey, ThumbnailProvider } from './types.js';

type RawEnv = Record<string, unknown>;

function optionalString(env: RawEnv, key: string): string | undefined {
  const value = env[key];
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function requiredString(env: RawEnv, key: string): string {
  const value = optionalString(env, key);
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function booleanValue(env: RawEnv, key: string, fallback: boolean): boolean {
  const value = optionalString(env, key);
  if (!value) return fallback;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  throw new Error(`${key} must be true or false`);
}

function positiveInteger(env: RawEnv, key: string, fallback: number, minimum = 1): number {
  const value = optionalString(env, key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${key} must be an integer of at least ${minimum}`);
  }
  return parsed;
}

function oneOf<T extends string>(env: RawEnv, key: string, allowed: readonly T[], fallback?: T): T | undefined {
  const value = optionalString(env, key) ?? fallback;
  if (value === undefined) return undefined;
  if (!allowed.includes(value as T)) {
    throw new Error(`${key} must be ${allowed.join(', ')}`);
  }
  return value as T;
}

function target(env: RawEnv, key: TargetKey, label: string, prefix: string, defaultUrl: string): TargetConfig {
  const applicationId = optionalString(env, `${prefix}_APPLICATION_ID`);
  const identityId = optionalString(env, `${prefix}_IDENTITY_ID`);
  return {
    key,
    label,
    applicationName: optionalString(env, `${prefix}_APPLICATION_NAME`) ?? label,
    applicationUrl: optionalString(env, `${prefix}_APPLICATION_URL`) ?? defaultUrl,
    ...(applicationId ? { applicationId } : {}),
    ...(identityId ? { identityId } : {}),
  };
}

export function parseConfig(input: unknown): Config {
  const env: RawEnv = input && typeof input === 'object' ? (input as RawEnv) : {};
  const slackBotToken = optionalString(env, 'SLACK_BOT_TOKEN');
  const slackChannelId = optionalString(env, 'SLACK_CHANNEL_ID');
  if (slackBotToken && !slackChannelId) {
    throw new Error('SLACK_CHANNEL_ID is required when SLACK_BOT_TOKEN is configured');
  }

  const openaiApiKey = optionalString(env, 'OPENAI_API_KEY');
  const geminiApiKey = optionalString(env, 'GEMINI_API_KEY');
  const thumbnailProvider =
    oneOf<ThumbnailProvider>(env, 'THUMBNAIL_PROVIDER', ['openai', 'gemini']) ??
    (openaiApiKey ? 'openai' : geminiApiKey ? 'gemini' : undefined);

  const optional = {
    slackWebhookUrl: optionalString(env, 'SLACK_WEBHOOK_URL'),
    slackBotToken,
    slackChannelId,
    slackSigningSecret: optionalString(env, 'SLACK_SIGNING_SECRET'),
    internalApiToken: optionalString(env, 'INTERNAL_API_TOKEN'),
    identityUserName: optionalString(env, 'IDENTITY_USER_NAME'),
    thumbnailProvider,
    thumbnailModel: optionalString(env, 'THUMBNAIL_MODEL'),
    openaiApiKey,
    geminiApiKey,
  };

  return {
    anchorApiBase: (optionalString(env, 'ANCHOR_API_BASE') ?? 'https://api.anchorbrowser.io/v1').replace(/\/+$/, ''),
    anchorApiKey: requiredString(env, 'ANCHOR_API_KEY'),
    port: positiveInteger(env, 'PORT', 8787),
    reauthAuthMethod: oneOf(env, 'REAUTH_AUTH_METHOD', ['profile', 'dynauth', 'credentials'], 'profile') as Config['reauthAuthMethod'],
    notifyRecovery: booleanValue(env, 'NOTIFY_RECOVERY', true),
    requestTimeoutMs: positiveInteger(env, 'REQUEST_TIMEOUT_MS', 20_000),
    taskTimeoutMs: positiveInteger(env, 'ANCHOR_REAUTH_TIMEOUT_MS', 900_000),
    longTaskTimeoutMs: positiveInteger(env, 'ANCHOR_CONTENT_TASK_TIMEOUT_MS', 1_800_000),
    taskPollIntervalMs: positiveInteger(env, 'ANCHOR_TASK_POLL_INTERVAL_MS', 3_000),
    thumbnailTimeoutMs: positiveInteger(env, 'THUMBNAIL_TIMEOUT_MS', 180_000),
    thumbnailOutputDir: resolve(optionalString(env, 'THUMBNAIL_OUTPUT_DIR') ?? 'state/thumbnails'),
    thumbnailReferenceImage: resolve(optionalString(env, 'THUMBNAIL_REFERENCE_IMAGE') ?? 'assets/thumbnail-reference.png'),
    autoPublishDelayMs: positiveInteger(env, 'AUTO_PUBLISH_DELAY_MS', 900_000, 0),
    stateFile: optionalString(env, 'NODE_STATE_FILE') ?? 'state/identity-monitor.json',
    draftFile: optionalString(env, 'NODE_DRAFT_FILE') ?? 'state/discovery-drafts.json',
    publishAuthor: optionalString(env, 'PUBLISH_AUTHOR') ?? 'Idan Raman',
    targets: [
      target(env, 'gauge', 'Gauge', 'GAUGE', 'https://app.withgauge.com'),
      target(env, 'search-console', 'Google Search Console', 'SEARCH_CONSOLE', 'https://search.google.com/search-console'),
    ],
    ...Object.fromEntries(Object.entries(optional).filter(([, value]) => value !== undefined)),
  };
}

export function readConfig(): Config {
  return parseConfig(process.env);
}
