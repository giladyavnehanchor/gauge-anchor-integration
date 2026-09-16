import type { Config, DiscoveryDraft, IdentityAlert, Log, PublishResult, SlackClient } from './types.js';

const DESTINATIONS = ['blogs', 'templates hubs', 'guides'];

function escape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function alertTitle(alert: IdentityAlert): string {
  const labels = {
    missing: 'identity missing',
    stale: 'identity needs re-authentication',
    pending: 'identity authentication pending',
    healthy: 'identity healthy',
    recovered: 'identity recovered',
  };
  return `${alert.target.label}: ${labels[alert.condition]}`;
}

function draftDetails(draft: DiscoveryDraft): string {
  const { article } = draft;
  return [
    `*Title:* ${escape(article.title)}`,
    `*Summary:* ${escape(article.summary)}`,
    `*Ticket:* ${escape(article.ticketUrl)}`,
    `*Research:* ${article.researchCompleted ? 'complete' : 'incomplete'}`,
    `*Outline:* ${article.outlineCompleted ? 'complete' : 'incomplete'}`,
    `*Article draft:* ${article.articleWritten ? 'written' : 'not written'}`,
    `*Result:* ${escape(article.message)}`,
  ].join('\n');
}

function thumbnailLines(draft: DiscoveryDraft): string {
  return draft.thumbnails
    .map((thumbnail, index) =>
      `${index + 1}. ${escape(thumbnail.title)} — ${escape(thumbnail.imageUrl ?? thumbnail.filePath ?? 'generated thumbnail')}`)
    .join('\n');
}

/** Shown on the initial draft message only; the countdown starts right after it is posted. */
function autoPublishNote(delayMs: number): unknown[] {
  if (delayMs === 0) return [];
  const minutes = Math.round(delayMs / 60_000);
  return [{
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `If nobody reacts within ${minutes} minutes, this article is published automatically to *blogs* with thumbnail 1. Any click here cancels that.`,
    }],
  }];
}

function publishResultBlocks(draft: DiscoveryDraft, result: PublishResult): { text: string; blocks: unknown[] } {
  const text = `Published <${result.articleUrl}|${escape(draft.article.title)}>. Search indexing: ${escape(result.indexingMessage)}`;
  const retry = result.indexingRequested
    ? []
    : [{
        type: 'actions',
        elements: [{
          type: 'button',
          action_id: 'request-indexing',
          text: { type: 'plain_text', text: 'Request indexing' },
          value: JSON.stringify({ draftId: draft.id }),
        }],
      }];
  return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }, ...retry] };
}

function draftBlocks(draft: DiscoveryDraft, includeImages: boolean, footer: unknown[] = []): unknown[] {
  const images = includeImages
    ? draft.thumbnails
        .filter((thumbnail) => thumbnail.imageUrl)
        .map((thumbnail) => ({ type: 'image', image_url: thumbnail.imageUrl, alt_text: thumbnail.title.slice(0, 200) }))
    : [];
  return [
    { type: 'header', text: { type: 'plain_text', text: 'Gauge: article ready for review' } },
    { type: 'section', text: { type: 'mrkdwn', text: draftDetails(draft) } },
    ...images,
    { type: 'section', text: { type: 'mrkdwn', text: `*Thumbnails:*\n${thumbnailLines(draft)}` } },
    {
      type: 'actions',
      block_id: 'thumbnail-selection',
      elements: draft.thumbnails.map((_, index) => ({
        type: 'button',
        action_id: `thumbnail-select-${index}`,
        text: { type: 'plain_text', text: `${draft.selectedThumbnailIndex === index ? '✓ ' : ''}Option ${index + 1}` },
        value: JSON.stringify({ draftId: draft.id, index }),
      })),
    },
    {
      type: 'actions',
      block_id: `destination-selection:${draft.id}`,
      elements: [
        {
          type: 'static_select',
          action_id: 'destination-select',
          placeholder: { type: 'plain_text', text: 'Choose destination' },
          ...(draft.selectedDestination
            ? { initial_option: { text: { type: 'plain_text', text: draft.selectedDestination }, value: draft.selectedDestination } }
            : {}),
          options: DESTINATIONS.map((destination) => ({ text: { type: 'plain_text', text: destination }, value: destination })),
        },
        {
          type: 'button',
          action_id: 'publish-article',
          text: { type: 'plain_text', text: 'Post' },
          style: 'primary',
          value: JSON.stringify({ draftId: draft.id }),
        },
      ],
    },
    ...footer,
  ];
}

type SlackConfig = Pick<Config, 'slackWebhookUrl' | 'slackBotToken' | 'slackChannelId' | 'requestTimeoutMs' | 'autoPublishDelayMs'>;

export class SlackWebhookClient implements SlackClient {
  constructor(
    private readonly config: SlackConfig,
    private readonly fetcher: typeof fetch = fetch,
    private readonly log: Log = (message, details) => console.log(message, details ?? ''),
    private readonly readFile?: (path: string) => Promise<Uint8Array>,
  ) {}

  async sendIdentityAlert(alert: IdentityAlert): Promise<void> {
    const title = alertTitle(alert);
    const context = [
      `*Application:* ${escape(alert.application.name)}`,
      alert.identity ? `*Identity:* ${escape(alert.identity.name)}` : '*Identity:* none',
    ].join('\n');
    if (!this.configured()) {
      this.log(`[slack stub] ${title}\n${context}\n${alert.link?.url ?? 'No authentication link generated.'}`);
      return;
    }

    const broken = alert.condition === 'missing' || alert.condition === 'stale';
    await this.post({
      text: `${title}. ${alert.link?.url ?? ''}`.trim(),
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: title.slice(0, 150) } },
        { type: 'section', text: { type: 'mrkdwn', text: context } },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: alert.link ? `<${alert.link.url}|Open Anchor authentication link>` : 'No link generated.',
          },
        },
        ...(broken
          ? [{
              type: 'actions',
              elements: [{
                type: 'button',
                action_id: 'run-discovery',
                text: { type: 'plain_text', text: 'Run discovery again' },
                value: JSON.stringify({ target: alert.target.key }),
              }],
            }]
          : []),
      ],
    });
  }

  async sendDraft(draft: DiscoveryDraft): Promise<void> {
    if (!this.configured()) {
      this.log(`[slack stub] Gauge: article ready for review\n${draftDetails(draft)}\n*Thumbnails:*\n${thumbnailLines(draft)}`);
      return;
    }
    await this.post({
      text: `Gauge: article ready for review: ${draft.article.title}`,
      blocks: draftBlocks(draft, true, autoPublishNote(this.config.autoPublishDelayMs)),
    });
    if (this.config.slackBotToken) await this.uploadThumbnails(draft);
  }

  async updateDraft(channelId: string, messageTs: string, draft: DiscoveryDraft): Promise<void> {
    await this.api('chat.update', {
      channel: channelId,
      ts: messageTs,
      text: `Gauge: article ready for review: ${draft.article.title}`,
      blocks: draftBlocks(draft, false),
    });
  }

  async sendPublishResult(draft: DiscoveryDraft, result: PublishResult, channelId?: string): Promise<void> {
    await this.postTo(channelId, publishResultBlocks(draft, result));
  }

  async sendChannelText(text: string, channelId?: string): Promise<void> {
    await this.postTo(channelId, { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }] });
  }

  private configured(): boolean {
    return Boolean(this.config.slackWebhookUrl || this.config.slackBotToken);
  }

  /** Replies into the channel that triggered an interaction, or into the configured channel otherwise. */
  private async postTo(channelId: string | undefined, payload: { text: string; blocks: unknown[] }): Promise<void> {
    if (channelId) {
      await this.api('chat.postMessage', { channel: channelId, ...payload });
      return;
    }
    if (!this.configured()) {
      this.log(`[slack stub] ${payload.text}`);
      return;
    }
    await this.post(payload);
  }

  private async post(payload: { text: string; blocks: unknown[] }): Promise<void> {
    if (this.config.slackBotToken) {
      if (!this.config.slackChannelId) throw new Error('SLACK_CHANNEL_ID is required with SLACK_BOT_TOKEN');
      await this.api('chat.postMessage', { channel: this.config.slackChannelId, ...payload });
      return;
    }
    const response = await this.fetcher(this.config.slackWebhookUrl as string, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const body = await response.text();
    if (!response.ok || body.trim() !== 'ok') {
      throw new Error(`Slack webhook failed with HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
  }

  private async uploadThumbnails(draft: DiscoveryDraft): Promise<void> {
    const readFile = this.readFile;
    const channelId = this.config.slackChannelId;
    const files = draft.thumbnails.filter((thumbnail) => thumbnail.filePath);
    if (!readFile || !channelId || files.length === 0) {
      this.log('Slack thumbnail upload skipped', { reason: 'no file reader, channel, or local files' });
      return;
    }

    const uploads = await Promise.all(files.map(async (thumbnail) => {
      const filePath = thumbnail.filePath as string;
      const data = await readFile(filePath);
      const upload = await this.api('files.getUploadURLExternal', {
        filename: filePath.split('/').pop() || 'thumbnail.png',
        length: data.byteLength,
      }, true);
      const response = await this.fetcher(String(upload.upload_url), {
        method: 'POST',
        headers: { 'content-type': thumbnail.mimeType ?? 'application/octet-stream' },
        body: data as unknown as BodyInit,
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`Slack file upload failed with HTTP ${response.status}`);
      return { id: String(upload.file_id), title: thumbnail.title };
    }));
    await this.api('files.completeUploadExternal', { files: uploads, channel_id: channelId }, true);
    this.log('Slack thumbnail upload completed', { count: uploads.length });
  }

  private async api(method: string, body: Record<string, unknown>, formEncoded = false): Promise<Record<string, unknown>> {
    if (!this.config.slackBotToken) throw new Error('SLACK_BOT_TOKEN is not configured');
    const requestBody = formEncoded
      ? new URLSearchParams(
          Object.entries(body).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
        )
      : JSON.stringify(body);
    const response = await this.fetcher(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${this.config.slackBotToken}`,
        'content-type': formEncoded ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8',
      },
      body: requestBody,
      signal: AbortSignal.timeout(this.config.requestTimeoutMs),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Slack API ${method} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const payload = (text ? JSON.parse(text) : {}) as Record<string, unknown>;
    if (payload.ok !== true) {
      throw new Error(`Slack API ${method} failed: ${typeof payload.error === 'string' ? payload.error : 'unknown_error'}`);
    }
    return payload;
  }
}
