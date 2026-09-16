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
    const client = new SlackWebhookClient({ requestTimeoutMs: 1000, autoPublishDelayMs: 900_000 }, fetcher, log);

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
      { slackBotToken: 'xoxb-test', slackChannelId: 'C123456', requestTimeoutMs: 1000, autoPublishDelayMs: 900_000 },
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
      { slackBotToken: 'xoxb-test', slackChannelId: 'C123456', requestTimeoutMs: 1000, autoPublishDelayMs: 900_000 },
      fetcher,
    );

    await client.sendDraft(readyDraft({ selectedThumbnailIndex: 1, selectedDestination: 'guides' }));

    const body = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(body).toContain('"action_id":"thumbnail-select-0"');
    expect(body).toContain('✓ Option 2');
    expect(body).toContain('"block_id":"destination-selection:draft-1"');
    expect(body).toContain('"action_id":"publish-article"');
    expect(body).toContain('"initial_option":{"text":{"type":"plain_text","text":"guides"}');
    expect(body).toContain('published automatically to *blogs* with thumbnail 1');
  });

  it('drops the auto-publish note when updating a draft after an interaction', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(okResponse());
    const client = new SlackWebhookClient(
      { slackBotToken: 'xoxb-test', slackChannelId: 'C123456', requestTimeoutMs: 1000, autoPublishDelayMs: 900_000 },
      fetcher,
    );

    await client.updateDraft('C123456', '1.0', readyDraft({ selectedThumbnailIndex: 0 }));

    const body = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://slack.com/api/chat.update');
    expect(body).not.toContain('published automatically');
  });

  it('posts publish results to the configured channel with a Request indexing button when indexing is pending', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => okResponse());
    const client = new SlackWebhookClient(
      { slackBotToken: 'xoxb-test', slackChannelId: 'C123456', requestTimeoutMs: 1000, autoPublishDelayMs: 900_000 },
      fetcher,
    );

    await client.sendPublishResult(readyDraft(), {
      articleUrl: 'https://anchorbrowser.io/blog/a',
      indexingRequested: false,
      indexingMessage: 'not requested; the Google Search Console identity needs re-authentication in Anchor',
    });
    await client.sendPublishResult(readyDraft(), {
      articleUrl: 'https://anchorbrowser.io/blog/a',
      indexingRequested: true,
      indexingMessage: 'Indexing requested',
    }, 'C999');

    const pending = String(fetcher.mock.calls[0]?.[1]?.body);
    expect(pending).toContain('"channel":"C123456"');
    expect(pending).toContain('"action_id":"request-indexing"');
    expect(pending).toContain('draft-1');
    const done = String(fetcher.mock.calls[1]?.[1]?.body);
    expect(done).toContain('"channel":"C999"');
    expect(done).not.toContain('request-indexing');
  });

  it('posts alerts through the incoming webhook when no bot token is set', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    const client = new SlackWebhookClient({ slackWebhookUrl: 'https://hooks.slack.test/webhook', requestTimeoutMs: 1000, autoPublishDelayMs: 900_000 }, fetcher);

    await client.sendIdentityAlert(alert);

    expect(fetcher).toHaveBeenCalledWith('https://hooks.slack.test/webhook', expect.objectContaining({ method: 'POST' }));
  });
});
