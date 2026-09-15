import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const baseEnv = {
  ANCHOR_API_KEY: 'anchor-secret',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.test/webhook',
};

describe('parseConfig', () => {
  it('builds both targets and defaults the API settings', () => {
    const config = parseConfig(baseEnv);

    expect(config.anchorApiBase).toBe('https://api.anchorbrowser.io/v1');
    expect(config.publishAuthor).toBe('Idan Raman');
    expect(config.thumbnailOutputDir).toMatch(/state\/thumbnails$/);
    expect(config.targets).toEqual([
      { key: 'gauge', label: 'Gauge', applicationName: 'Gauge', applicationUrl: 'https://app.withgauge.com' },
      {
        key: 'search-console',
        label: 'Google Search Console',
        applicationName: 'Google Search Console',
        applicationUrl: 'https://search.google.com/search-console',
      },
    ]);
  });

  it('picks the thumbnail provider from the configured key', () => {
    expect(parseConfig({ ...baseEnv, GEMINI_API_KEY: 'g' }).thumbnailProvider).toBe('gemini');
    expect(parseConfig({ ...baseEnv, OPENAI_API_KEY: 'o' }).thumbnailProvider).toBe('openai');
    expect(parseConfig(baseEnv).thumbnailProvider).toBeUndefined();
    expect(() => parseConfig({ ...baseEnv, THUMBNAIL_PROVIDER: 'anthropic' })).toThrow('THUMBNAIL_PROVIDER must be openai, gemini');
  });

  it('requires a channel when Slack Bot API delivery is enabled', () => {
    expect(() => parseConfig({ ...baseEnv, SLACK_BOT_TOKEN: 'xoxb-test' })).toThrow('SLACK_CHANNEL_ID is required');
    expect(parseConfig({ ...baseEnv, SLACK_BOT_TOKEN: 'xoxb-test', SLACK_CHANNEL_ID: 'C123456' }).slackChannelId).toBe('C123456');
  });

  it('rejects missing secrets and invalid auth methods', () => {
    expect(() => parseConfig({})).toThrow('ANCHOR_API_KEY is required');
    expect(() => parseConfig({ ...baseEnv, REAUTH_AUTH_METHOD: 'unknown' })).toThrow(
      'REAUTH_AUTH_METHOD must be profile, dynauth, credentials',
    );
  });
});
