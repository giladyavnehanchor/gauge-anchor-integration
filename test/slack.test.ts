import { describe, expect, it, vi } from 'vitest';
import { SlackWebhookClient } from '../src/slack.js';

const message = {
  target: {
    key: 'gauge' as const,
    label: 'Gauge',
    applicationName: 'Gauge',
    applicationUrl: 'https://app.withgauge.com',
  },
  condition: 'stale' as const,
  application: {
    id: 'app-1',
    name: 'Gauge',
    url: 'https://app.withgauge.com',
  },
  identity: {
    id: 'identity-1',
    name: 'Gauge account',
    status: 'agent_invalid' as const,
  },
  link: {
    url: 'https://app.anchorbrowser.io/identity/re-authenticate?token=test',
    expiresAt: '2030-01-01T00:00:00Z',
  },
};

describe('SlackWebhookClient', () => {
  it('prints a stub notification when no webhook is configured', async () => {
    const logger = vi.fn();
    const fetcher = vi.fn<typeof fetch>();
    const client = new SlackWebhookClient(
      { requestTimeoutMs: 1000 },
      fetcher,
      logger,
    );

    await client.send(message);

    expect(fetcher).not.toHaveBeenCalled();
    expect(logger).toHaveBeenCalledWith(
      expect.stringContaining('[slack stub] Gauge: identity needs re-authentication'),
    );
    expect(logger).toHaveBeenCalledWith(expect.stringContaining(message.link.url));
  });

  it('posts identity notifications with the Slack Bot Token', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, ts: '2030.1' }), { status: 200 }),
    );
    const client = new SlackWebhookClient(
      {
        slackBotToken: 'xoxb-test',
        slackChannelId: 'C123456',
        requestTimeoutMs: 1000,
      },
      fetcher,
    );

    await client.send(message);

    expect(fetcher).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer xoxb-test',
        }),
        body: expect.stringContaining('"channel":"C123456"'),
      }),
    );
    expect(fetcher).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        body: expect.stringContaining('"action_id":"run-discovery"'),
      }),
    );
  });
});
