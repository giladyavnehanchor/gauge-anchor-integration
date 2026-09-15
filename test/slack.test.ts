import { describe, expect, it, vi } from 'vitest';
import { SlackWebhookClient } from '../src/slack.js';
import type { IdentityAlert } from '../src/types.js';
import { gaugeApplication, readyDraft } from './fakes.js';

const alert: IdentityAlert = {
  target: { key: 'gauge', label: 'Gauge', applicationName: 'Gauge', applicationUrl: 'https://app.withgauge.com' },
  condition: 'stale',
  application: gaugeApplication,
  identity: { id: 'identity-1', name: 'Gauge account', status: 'agent_invalid' },
  link: { url: 'https://app.anchorbrowser.io/identity/re-authenticate?token=test', expiresAt: '2030-01-01T00:00:00Z' },
};

function okResponse(): Response {
  return new Response(JSON.stringify({ ok: true, ts: '2030.1' }), { status: 200 });
}

describe('SlackWebhookClient', () => {
  it('logs a stub notification when Slack is not configured', async () => {
    const log = vi.fn();
    const fetcher = vi.fn<typeof fetch>();
    const client = new SlackWebhookClient({ requestTimeoutMs: 1000 }, fetcher, log);

    await client.sendIdentityAlert(alert);
    await client.sendDraft(readyDraft());

    expect(fetcher).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('[slack stub] Gauge: identity needs re-authentication'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining(alert.link!.url));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('A Gauge article'));
  });

  it('posts identity alerts with the bot token and a retry button', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const client = new SlackWebhookClient(
      { slackBotToken: 'xoxb-test', slackChannelId: 'C123456', requestTimeoutMs: 1000 },
      fetcher,
    );

    await client.sendIdentityAlert(alert);

    expect(fetcher).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer xoxb-test' }),
        body: expect.stringContaining('"channel":"C123456"'),
      }),
    );
    expect(String(fetcher.mock.calls[0]?.[1]?.body)).toContain('"action_id":"run-discovery"');
  });

  it('posts a draft with thumbnail, destination, and publish controls', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const client = new SlackWebhookClient(
      { slackBotToken: 'xoxb-test', slackChannelId: 'C123456', requestTimeoutMs: 1000 },
      fetcher,
    );

    await client.sendDraft(readyDraft({ selectedThumbnailIndex: 1, selectedDestination: 'guides' }));

    const body = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(body).toContain('"action_id":"thumbnail-select-0"');
    expect(body).toContain('✓ Option 2');
    expect(body).toContain('"block_id":"destination-selection:draft-1"');
    expect(body).toContain('"action_id":"publish-article"');
    expect(body).toContain('"initial_option":{"text":{"type":"plain_text","text":"guides"}');
  });

  it('posts alerts through the incoming webhook when no bot token is set', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    const client = new SlackWebhookClient({ slackWebhookUrl: 'https://hooks.slack.test/webhook', requestTimeoutMs: 1000 }, fetcher);

    await client.sendIdentityAlert(alert);

    expect(fetcher).toHaveBeenCalledWith('https://hooks.slack.test/webhook', expect.objectContaining({ method: 'POST' }));
  });
});
