import { describe, expect, it, vi } from 'vitest';
import {
  prepareDataForSlack,
  runGaugeContentWorkflow,
  sendGaugeContentToSlack,
} from '../src/content-pipeline.js';
import type {
  AnchorApplication,
  AnchorClient,
  GaugeContentTaskResult,
  MonitorConfig,
  MonitorRunResult,
  SlackClient,
  ThumbnailClient,
} from '../src/types.js';

const gaugeApplication: AnchorApplication = {
  id: 'gauge-app',
  name: 'Gauge',
  url: 'https://app.withgauge.com',
};

const config: MonitorConfig = {
  anchorApiBase: 'https://api.anchorbrowser.io/v1',
  anchorApiKey: 'test-key',
  reauthAuthMethod: 'profile',
  notifyRecovery: true,
  dryRun: false,
  requestTimeoutMs: 1000,
  reauthTimeoutMs: 1000,
  taskPollIntervalMs: 1,
  contentTaskTimeoutMs: 1000,
  gaugeContentTaskName: 'gauge-content-research-outline',
  gaugePublishTaskName: 'gauge-publish-article-from-todo',
  searchConsoleIndexTaskName: 'search-console-request-indexing',
  port: 8787,
  thumbnailProvider: 'openai',
  openaiApiKey: 'test-openai-key',
  targets: [
    {
      key: 'gauge',
      label: 'Gauge',
      applicationName: 'Gauge',
      applicationUrl: 'https://app.withgauge.com',
    },
  ],
};

const monitorResult: MonitorRunResult = {
  startedAt: '2030-01-01T00:00:00.000Z',
  completedAt: '2030-01-01T00:01:00.000Z',
  targets: [
    {
      target: 'gauge',
      condition: 'healthy',
      application: gaugeApplication,
      applicationId: 'gauge-app',
      identityId: 'gauge-identity',
      notified: false,
    },
    {
      target: 'search-console',
      condition: 'healthy',
      application: {
        id: 'search-app',
        name: 'Google Search Console',
        url: 'https://search.google.com/search-console',
      },
      applicationId: 'search-app',
      identityId: 'search-identity',
      notified: false,
    },
  ],
};

const content: GaugeContentTaskResult = {
  ticketUrl: 'https://app.withgauge.com/ticket/1',
  articleTitle: 'Article title',
  articleSummary: 'Article summary',
  researchCompleted: true,
  outlineCompleted: true,
  published: false,
  message: 'Ready for review',
};

const generatedThumbnails = [
  { title: 'Option 1', prompt: 'prompt', filePath: '/tmp/one.png' },
  { title: 'Option 2', prompt: 'prompt', filePath: '/tmp/two.png' },
  { title: 'Option 3', prompt: 'prompt', filePath: '/tmp/three.png' },
  { title: 'Option 4', prompt: 'prompt', filePath: '/tmp/four.png' },
  { title: 'Option 5', prompt: 'prompt', filePath: '/tmp/five.png' },
];

describe('runGaugeContentWorkflow', () => {
  it('returns Gauge content from Anchor', async () => {
    const anchor = {
      runGaugeContentTask: vi.fn().mockResolvedValue(content),
    } as unknown as AnchorClient;

    await expect(
      runGaugeContentWorkflow(config, monitorResult, { anchor }),
    ).resolves.toEqual(content);
    expect(anchor.runGaugeContentTask).toHaveBeenCalledWith(
      'gauge-app',
      'gauge-identity',
      'gauge-content-research-outline',
    );
  });

  it('runs content when Gauge is healthy even if Search Console is stale', async () => {
    const anchor = {
      runGaugeContentTask: vi.fn().mockResolvedValue(content),
    } as unknown as AnchorClient;

    await expect(
      runGaugeContentWorkflow(
        config,
        {
          ...monitorResult,
          targets: monitorResult.targets.map((target) =>
            target.target === 'search-console'
              ? { ...target, condition: 'stale' }
              : target,
          ),
        },
        { anchor },
      ),
    ).resolves.toEqual(content);
    expect(anchor.runGaugeContentTask).toHaveBeenCalledOnce();
  });
});

describe('prepareDataForSlack', () => {
  it('generates thumbnails for the Gauge article', async () => {
    const thumbnails = {
      generate: vi.fn().mockResolvedValue(generatedThumbnails),
    } as ThumbnailClient;

    await expect(prepareDataForSlack(config, content, { thumbnails })).resolves.toEqual({
      result: content,
      thumbnails: generatedThumbnails,
    });
    expect(thumbnails.generate).toHaveBeenCalledWith('Article title', 'Article summary');
  });
});

describe('sendGaugeContentToSlack', () => {
  it('sends the prepared digest to Slack', async () => {
    const sendGaugeContent = vi.fn();
    const slack = { sendGaugeContent } as unknown as SlackClient;

    await sendGaugeContentToSlack(
      config,
      monitorResult,
      { result: content, thumbnails: generatedThumbnails },
      { slack },
    );
    expect(sendGaugeContent).toHaveBeenCalledOnce();
  });
});
