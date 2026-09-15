import type {
  GaugeContentMessage,
  MonitorConfig,
  SlackClient,
  SlackMessage,
} from './types.js';

function markdownText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function conditionLabel(message: SlackMessage): string {
  if (message.condition === 'missing') return 'identity missing';
  if (message.condition === 'stale') return 'identity needs re-authentication';
  if (message.condition === 'pending') return 'identity authentication pending';
  return 'identity recovered';
}

export class SlackWebhookClient implements SlackClient {
  constructor(
    private readonly config: Pick<
      MonitorConfig,
      'slackWebhookUrl' | 'slackBotToken' | 'slackChannelId' | 'requestTimeoutMs'
    >,
    private readonly fetcher: typeof fetch = fetch,
    private readonly logger: (
      message: string,
      details?: Record<string, unknown>,
    ) => void = (message, details) => console.log(message, details ?? ''),
    private readonly readFile?: (path: string) => Promise<Uint8Array>,
  ) {}

  async send(message: SlackMessage): Promise<void> {
    const title = `${message.target.label}: ${conditionLabel(message)}`;
    const context = [
      `*Application:* ${markdownText(message.application.name)}`,
      message.identity ? `*Identity:* ${markdownText(message.identity.name)}` : '*Identity:* none',
    ].join('\n');
    if (!this.config.slackWebhookUrl && !this.config.slackBotToken) {
      this.logger(
        `[slack stub] ${title}\n${context}\n${message.link?.url ?? 'No authentication link generated.'}`,
      );
      return;
    }

    const linkText = message.link
      ? `<${message.link.url}|Open Anchor authentication link>`
      : 'No link generated in dry-run mode.';
    const payload = {
      text: `${title}. ${message.link?.url ?? ''}`.trim(),
      blocks: [
        {
          type: 'header',
          text: { type: 'plain_text', text: title.slice(0, 150) },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: context },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: linkText },
        },
        ...(message.condition === 'missing' || message.condition === 'stale'
          ? [{
              type: 'actions',
              elements: [{
                type: 'button',
                action_id: 'run-discovery',
                text: { type: 'plain_text', text: 'Run discovery again' },
                value: JSON.stringify({ target: message.target.key }),
              }],
            }]
          : []),
      ],
    };

    if (this.config.slackBotToken) {
      await this.postMessage(payload);
      return;
    }

    const webhookUrl = this.config.slackWebhookUrl;
    if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL is not configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetcher(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok || body.trim() !== 'ok') {
        throw new Error(`Slack webhook failed with HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Slack webhook request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async sendGaugeContent(message: GaugeContentMessage): Promise<void> {
    const { result } = message;
    const title = `${message.target.label}: article ready for review`;
    const details = [
      `*Title:* ${markdownText(result.articleTitle)}`,
      `*Summary:* ${markdownText(result.articleSummary)}`,
      `*Ticket:* ${markdownText(result.ticketUrl)}`,
      `*Research:* ${result.researchCompleted ? 'complete' : 'incomplete'}`,
      `*Outline:* ${result.outlineCompleted ? 'complete' : 'incomplete'}`,
      `*Published:* ${result.published ? 'yes' : 'no'}`,
      `*Result:* ${markdownText(result.message)}`,
    ].join('\n');
    const thumbnailLines = message.thumbnails.map((thumbnail, index) =>
      `${index + 1}. ${markdownText(thumbnail.title)} — ${markdownText(
        thumbnail.imageUrl ?? thumbnail.filePath ?? 'generated thumbnail',
      )}`,
    );

    if (!this.config.slackWebhookUrl && !this.config.slackBotToken) {
      this.logger(
        `[slack stub] ${title}\n${details}\n*Thumbnails:*\n${thumbnailLines.join('\n')}`,
      );
      return;
    }

    const imageBlocks = message.thumbnails
      .filter((thumbnail) => thumbnail.imageUrl)
      .map((thumbnail) => ({
        type: 'image',
        image_url: thumbnail.imageUrl,
        alt_text: thumbnail.title.slice(0, 200),
      }));
    const payload = {
      text: `${title}: ${result.articleTitle}`,
      blocks: this.buildGaugeContentBlocks(
        message,
        title,
        details,
        thumbnailLines,
        imageBlocks,
      ),
    };
    if (this.config.slackBotToken) {
      await this.postMessage(payload);
      await this.uploadThumbnailFiles(message);
      return;
    }
    await this.postWebhook(payload);
  }

  async updateGaugeContentMessage(
    channelId: string,
    messageTs: string,
    message: GaugeContentMessage,
  ): Promise<void> {
    const title = `${message.target.label}: article ready for review`;
    const details = [
      `*Title:* ${markdownText(message.result.articleTitle)}`,
      `*Summary:* ${markdownText(message.result.articleSummary)}`,
      `*Ticket:* ${markdownText(message.result.ticketUrl)}`,
      `*Research:* ${message.result.researchCompleted ? 'complete' : 'incomplete'}`,
      `*Outline:* ${message.result.outlineCompleted ? 'complete' : 'incomplete'}`,
      `*Published:* ${message.result.published ? 'yes' : 'no'}`,
      `*Result:* ${markdownText(message.result.message)}`,
    ].join('\n');
    const thumbnailLines = message.thumbnails.map((thumbnail, index) =>
      `${index + 1}. ${markdownText(thumbnail.title)} — ${markdownText(
        thumbnail.imageUrl ?? thumbnail.filePath ?? 'generated thumbnail',
      )}`,
    );
    await this.slackApi('chat.update', {
      channel: channelId,
      ts: messageTs,
      text: `${title}: ${message.result.articleTitle}`,
      blocks: this.buildGaugeContentBlocks(
        message,
        title,
        details,
        thumbnailLines,
        [],
      ),
    });
  }

  async sendChannelText(channelId: string, text: string): Promise<void> {
    await this.slackApi('chat.postMessage', {
      channel: channelId,
      text,
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text } }],
    });
  }

  private buildGaugeContentBlocks(
    message: GaugeContentMessage,
    title: string,
    details: string,
    thumbnailLines: string[],
    imageBlocks: unknown[],
  ): unknown[] {
    const blocks: unknown[] = [
      {
        type: 'header',
        text: { type: 'plain_text', text: title.slice(0, 150) },
      },
      { type: 'section', text: { type: 'mrkdwn', text: details } },
      ...imageBlocks,
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Thumbnails:*\n${thumbnailLines.join('\n')}`,
        },
      },
    ];
    if (!message.draftId) return blocks;

    blocks.push({
      type: 'actions',
      block_id: 'thumbnail-selection',
      elements: message.thumbnails.map((_, index) => ({
        type: 'button',
        action_id: `thumbnail-select-${index}`,
        text: {
          type: 'plain_text',
          text: `${message.selectedThumbnailIndex === index ? '✓ ' : ''}Option ${index + 1}`,
        },
        value: JSON.stringify({ draftId: message.draftId, index }),
      })),
    });
    blocks.push({
      type: 'actions',
      block_id: `destination-selection:${message.draftId}`,
      elements: [
        {
          type: 'static_select',
          action_id: 'destination-select',
          placeholder: { type: 'plain_text', text: 'Choose destination' },
          ...(message.destination
            ? {
                initial_option: {
                  text: { type: 'plain_text', text: message.destination },
                  value: message.destination,
                },
              }
            : {}),
          options: [
            'blogs',
            'templates hubs',
            'guides',
          ].map((destination) => ({
            text: { type: 'plain_text', text: destination },
            value: destination,
          })),
        },
        {
          type: 'button',
          action_id: 'publish-article',
          text: { type: 'plain_text', text: 'Post' },
          style: 'primary',
          value: JSON.stringify({ draftId: message.draftId }),
        },
      ],
    });
    return blocks;
  }

  private async postMessage(payload: {
    text: string;
    blocks: unknown[];
  }): Promise<void> {
    if (!this.config.slackBotToken || !this.config.slackChannelId) {
      throw new Error('Slack Bot Token and channel ID are required');
    }
    await this.slackApi('chat.postMessage', {
      channel: this.config.slackChannelId,
      ...payload,
    });
  }

  private async uploadThumbnailFiles(message: GaugeContentMessage): Promise<void> {
    const readFile = this.readFile;
    if (!readFile || !this.config.slackBotToken || !this.config.slackChannelId) {
      this.logger('Slack thumbnail upload skipped', {
        reason: this.readFile ? 'thumbnail file paths unavailable' : 'file reader unavailable',
      });
      return;
    }
    const files = message.thumbnails.filter((thumbnail) => thumbnail.filePath);
    if (files.length === 0) {
      this.logger('Slack thumbnail upload skipped', { reason: 'no local thumbnail files' });
      return;
    }

    const uploads = await Promise.all(
      files.map(async (thumbnail) => {
        const filePath = thumbnail.filePath as string;
        const data = await readFile(filePath);
        const fileName = filePath.split('/').pop() || 'thumbnail.png';
        const upload = await this.slackApi('files.getUploadURLExternal', {
          filename: fileName,
          length: data.byteLength,
        }, true);
        const uploadUrl = this.stringField(upload, 'upload_url', 'Slack upload');
        const fileId = this.stringField(upload, 'file_id', 'Slack upload');
        const response = await this.fetcher(uploadUrl, {
          method: 'POST',
          headers: {
            'content-type': thumbnail.mimeType ?? 'application/octet-stream',
          },
          body: data as unknown as BodyInit,
          signal: AbortSignal.timeout(this.config.requestTimeoutMs),
        });
        if (!response.ok) {
          throw new Error(`Slack file upload failed with HTTP ${response.status}`);
        }
        return { id: fileId, title: thumbnail.title };
      }),
    );
    await this.slackApi('files.completeUploadExternal', {
      files: uploads,
      channel_id: this.config.slackChannelId,
    }, true);
    this.logger('Slack thumbnail upload completed', {
      count: uploads.length,
      channelId: this.config.slackChannelId,
    });
  }

  private async slackApi(
    method: string,
    body: Record<string, unknown>,
    formEncoded = false,
  ): Promise<Record<string, unknown>> {
    if (!this.config.slackBotToken) throw new Error('SLACK_BOT_TOKEN is not configured');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const requestBody = formEncoded
        ? Object.entries(body).reduce((params, [key, value]) => {
            params.set(
              key,
              typeof value === 'string' ? value : JSON.stringify(value),
            );
            return params;
          }, new URLSearchParams())
        : JSON.stringify(body);
      const response = await this.fetcher(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${this.config.slackBotToken}`,
          'content-type': formEncoded
            ? 'application/x-www-form-urlencoded'
            : 'application/json; charset=utf-8',
        },
        body: requestBody,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(`Slack API ${method} failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      const payload = text ? JSON.parse(text) as unknown : {};
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error(`Slack API ${method} returned an invalid response`);
      }
      const result = payload as Record<string, unknown>;
      if (result.ok !== true) {
        throw new Error(
          `Slack API ${method} failed: ${
            typeof result.error === 'string' ? result.error : 'unknown_error'
          }`,
        );
      }
      return result;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Slack API ${method} request timed out`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private stringField(
    value: Record<string, unknown>,
    key: string,
    context: string,
  ): string {
    if (typeof value[key] !== 'string' || !value[key]) {
      throw new Error(`${context} response is missing ${key}`);
    }
    return value[key] as string;
  }

  private async postWebhook(payload: unknown): Promise<void> {
    if (!this.config.slackWebhookUrl) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    try {
      const response = await this.fetcher(this.config.slackWebhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok || body.trim() !== 'ok') {
        throw new Error(`Slack webhook failed with HTTP ${response.status}: ${body.slice(0, 200)}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Slack webhook request timed out');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
