import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';

const baseEnv = {
  ANCHOR_API_KEY: 'anchor-secret',
  SLACK_WEBHOOK_URL: 'https://hooks.slack.test/webhook',
};

describe('parseConfig', () => {
  it('builds both configured targets and defaults the API settings', () => {
    const config = parseConfig(baseEnv);

    expect(config.anchorApiBase).toBe('https://api.anchorbrowser.io/v1');
    expect(config.targets).toEqual([
      {
        key: 'gauge',
        label: 'Gauge',
        applicationName: 'Gauge',
        applicationUrl: 'https://app.withgauge.com',
        validationTaskName: 'anchor-identity-monitor-gauge-dom-check',
      },
      {
        key: 'search-console',
        label: 'Google Search Console',
        applicationName: 'Google Search Console',
        applicationUrl: 'https://search.google.com/search-console',
        validationTaskName: 'anchor-identity-monitor-search-console-dom-check',
      },
    ]);
  });

  it('allows operation without a Slack secret while Slack is stubbed', () => {
    expect(parseConfig({ ANCHOR_API_KEY: 'anchor-secret' }).slackWebhookUrl).toBeUndefined();
    expect(parseConfig({ ...baseEnv, SLACK_WEBHOOK_URL: '', DRY_RUN: 'true' }).dryRun).toBe(true);
  });

  it('requires a channel when Slack Bot API delivery is enabled', () => {
    expect(() =>
      parseConfig({ ...baseEnv, SLACK_BOT_TOKEN: 'xoxb-test' }),
    ).toThrow('SLACK_CHANNEL_ID is required');
    expect(
      parseConfig({
        ...baseEnv,
        SLACK_BOT_TOKEN: 'xoxb-test',
        SLACK_CHANNEL_ID: 'C123456',
      }).slackChannelId,
    ).toBe('C123456');
  });

  it('rejects missing secrets and invalid auth methods', () => {
    expect(() => parseConfig({})).toThrow('ANCHOR_API_KEY is required');
    expect(() =>
      parseConfig({ ...baseEnv, REAUTH_AUTH_METHOD: 'unknown' }),
    ).toThrow('REAUTH_AUTH_METHOD must be profile, dynauth, or credentials');
  });
});
