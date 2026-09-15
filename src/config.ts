import type {
  MonitorConfig,
  TargetConfig,
  TargetKey,
  ThumbnailProvider,
} from './types.js';

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

function positiveInteger(env: RawEnv, key: string, fallback: number): number {
  const value = optionalString(env, key);
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${key} must be a positive integer`);
  }
  return parsed;
}

function target(
  env: RawEnv,
  key: TargetKey,
  label: string,
  prefix: string,
  defaultUrl: string,
): TargetConfig {
  const applicationId = optionalString(env, `${prefix}_APPLICATION_ID`);
  const applicationUrl = optionalString(env, `${prefix}_APPLICATION_URL`) ?? defaultUrl;
  const identityId = optionalString(env, `${prefix}_IDENTITY_ID`);
  const applicationName = optionalString(env, `${prefix}_APPLICATION_NAME`) ?? label;

  return {
    key,
    label,
    ...(applicationId ? { applicationId } : {}),
    applicationName,
    applicationUrl,
    ...(identityId ? { identityId } : {}),
    validationTaskName:
      optionalString(env, `${prefix}_VALIDATION_TASK_NAME`) ??
      `anchor-identity-monitor-${key}-dom-check`,
  };
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function parseConfig(input: unknown): MonitorConfig {
  const env: RawEnv =
    input && typeof input === 'object' ? (input as RawEnv) : {};
  const anchorApiKey = requiredString(env, 'ANCHOR_API_KEY');
  const dryRun = booleanValue(env, 'DRY_RUN', false);
  const slackWebhookUrl = optionalString(env, 'SLACK_WEBHOOK_URL');
  const slackBotToken = optionalString(env, 'SLACK_BOT_TOKEN');
  const slackChannelId = optionalString(env, 'SLACK_CHANNEL_ID');
  const slackSigningSecret = optionalString(env, 'SLACK_SIGNING_SECRET');
  const internalApiToken = optionalString(env, 'INTERNAL_API_TOKEN');
  if (slackBotToken && !slackChannelId) {
    throw new Error('SLACK_CHANNEL_ID is required when SLACK_BOT_TOKEN is configured');
  }

  const authMethod = optionalString(env, 'REAUTH_AUTH_METHOD') ?? 'profile';
  if (!['profile', 'dynauth', 'credentials'].includes(authMethod)) {
    throw new Error('REAUTH_AUTH_METHOD must be profile, dynauth, or credentials');
  }

  const identityUserName = optionalString(env, 'IDENTITY_USER_NAME');
  const thumbnailProvider = optionalString(env, 'THUMBNAIL_PROVIDER');
  if (
    thumbnailProvider &&
    !['openai', 'gemini', 'anthropic'].includes(thumbnailProvider)
  ) {
    throw new Error('THUMBNAIL_PROVIDER must be openai, gemini, or anthropic');
  }
  const openaiApiKey = optionalString(env, 'OPENAI_API_KEY');
  const geminiApiKey = optionalString(env, 'GEMINI_API_KEY');
  const anthropicApiKey = optionalString(env, 'ANTHROPIC_API_KEY');
  const selectedThumbnailProvider =
    thumbnailProvider ??
    (openaiApiKey ? 'openai' : geminiApiKey ? 'gemini' : anthropicApiKey ? 'anthropic' : undefined);
  const thumbnailModel = optionalString(env, 'THUMBNAIL_MODEL');
  const thumbnailOutputDir = optionalString(env, 'THUMBNAIL_OUTPUT_DIR');
  return {
    anchorApiBase: normalizeBaseUrl(
      optionalString(env, 'ANCHOR_API_BASE') ?? 'https://api.anchorbrowser.io/v1',
    ),
    anchorApiKey,
    ...(slackWebhookUrl ? { slackWebhookUrl } : {}),
    ...(slackBotToken ? { slackBotToken } : {}),
    ...(slackChannelId ? { slackChannelId } : {}),
    ...(slackSigningSecret ? { slackSigningSecret } : {}),
    ...(internalApiToken ? { internalApiToken } : {}),
    port: positiveInteger(env, 'PORT', 8787),
    ...(identityUserName ? { identityUserName } : {}),
    reauthAuthMethod: authMethod as MonitorConfig['reauthAuthMethod'],
    notifyRecovery: booleanValue(env, 'NOTIFY_RECOVERY', true),
    dryRun,
    requestTimeoutMs: positiveInteger(env, 'REQUEST_TIMEOUT_MS', 20_000),
    reauthTimeoutMs: positiveInteger(env, 'ANCHOR_REAUTH_TIMEOUT_MS', 900_000),
    taskPollIntervalMs: positiveInteger(env, 'ANCHOR_TASK_POLL_INTERVAL_MS', 3_000),
    contentTaskTimeoutMs: positiveInteger(env, 'ANCHOR_CONTENT_TASK_TIMEOUT_MS', 1_800_000),
    thumbnailTimeoutMs: positiveInteger(env, 'THUMBNAIL_TIMEOUT_MS', 180_000),
    gaugeContentTaskName:
      optionalString(env, 'GAUGE_CONTENT_TASK_NAME') ??
      'gauge-content-research-outline',
    gaugePublishTaskName:
      optionalString(env, 'GAUGE_PUBLISH_TASK_NAME') ??
      'gauge-publish-article-from-todo',
    searchConsoleIndexTaskName:
      optionalString(env, 'SEARCH_CONSOLE_INDEX_TASK_NAME') ??
      'search-console-request-indexing',
    ...(selectedThumbnailProvider
      ? { thumbnailProvider: selectedThumbnailProvider as ThumbnailProvider }
      : {}),
    ...(thumbnailModel ? { thumbnailModel } : {}),
    ...(thumbnailOutputDir ? { thumbnailOutputDir } : {}),
    ...(openaiApiKey ? { openaiApiKey } : {}),
    ...(geminiApiKey ? { geminiApiKey } : {}),
    ...(anthropicApiKey ? { anthropicApiKey } : {}),
    targets: [
      target(env, 'gauge', 'Gauge', 'GAUGE', 'https://app.withgauge.com'),
      target(
        env,
        'search-console',
        'Google Search Console',
        'SEARCH_CONSOLE',
        'https://search.google.com/search-console',
      ),
    ],
  };
}

export function readNodeConfig(): MonitorConfig {
  return parseConfig(process.env);
}
