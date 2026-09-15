import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { indexWithGoogleSearchConsole, publishDraft } from '../src/publish-pipeline.js';
import type {
  AnchorClient,
  DiscoveryDraft,
  MonitorConfig,
} from '../src/types.js';
import type { DraftStore } from '../src/drafts.js';

class MemoryDraftStore implements DraftStore {
  constructor(private draft: DiscoveryDraft) {}

  async get(): Promise<DiscoveryDraft | undefined> {
    return this.draft;
  }

  async put(draft: DiscoveryDraft): Promise<void> {
    this.draft = draft;
  }
}

const config = {
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
  targets: [],
} satisfies MonitorConfig;

async function setup() {
  const outputDir = await mkdtemp(join(tmpdir(), 'anchor-monitor-'));
  const thumbnailPath = join(outputDir, 'thumbnail-1.png');
  await writeFile(thumbnailPath, Buffer.from('thumbnail'));
  const draft: DiscoveryDraft = {
    id: 'draft-1',
    createdAt: '2030-01-01T00:00:00.000Z',
    application: { id: 'gauge-app', name: 'Gauge', url: 'https://app.withgauge.com' },
    content: {
      ticketUrl: 'https://app.withgauge.com/ticket/1',
      articleTitle: 'Article',
      articleSummary: 'Summary',
      researchCompleted: true,
      outlineCompleted: true,
      published: false,
      message: 'Ready',
    },
    applicationId: 'gauge-app',
    identityId: 'gauge-identity',
    searchConsoleApplicationId: 'search-app',
    searchConsoleIdentityId: 'search-identity',
    ticketUrl: 'https://app.withgauge.com/ticket/1',
    articleTitle: 'Article',
    articleSummary: 'Summary',
    thumbnails: [{ title: 'Option 1', prompt: 'prompt', filePath: thumbnailPath }],
    status: 'ready',
  };
  return { outputDir, thumbnailPath, draft };
}

describe('publishDraft', () => {
  it('publishes only the selected Todo draft', async () => {
    const { outputDir, thumbnailPath, draft } = await setup();
    const store = new MemoryDraftStore(draft);
    const anchor = {
      publishGaugeArticle: vi.fn().mockResolvedValue('https://app.withgauge.com/article-1'),
      requestSearchConsoleIndexing: vi.fn(),
    } as unknown as AnchorClient;

    await expect(
      publishDraft(
        config,
        {
          draftId: draft.id,
          ticketUrl: draft.ticketUrl,
          articleTitle: draft.articleTitle,
          articleSummary: draft.articleSummary,
          thumbnailPath,
          destination: 'blogs',
        },
        { anchor, drafts: store, thumbnailOutputDir: outputDir },
      ),
    ).resolves.toBe('https://app.withgauge.com/article-1');
    expect(anchor.publishGaugeArticle).toHaveBeenCalledWith(
      'gauge-app',
      'gauge-identity',
      'gauge-publish-article-from-todo',
      expect.objectContaining({ destination: 'blogs' }),
      expect.objectContaining({ fileName: 'thumbnail-1.png' }),
    );
    expect(anchor.requestSearchConsoleIndexing).not.toHaveBeenCalled();
  });

  it('returns the stored article URL without publishing twice', async () => {
    const { outputDir, thumbnailPath, draft } = await setup();
    const store = new MemoryDraftStore({
      ...draft,
      publishedArticleUrl: 'https://app.withgauge.com/article-1',
    });
    const anchor = {
      publishGaugeArticle: vi.fn(),
      requestSearchConsoleIndexing: vi.fn(),
    } as unknown as AnchorClient;

    await expect(
      publishDraft(
        config,
        {
          draftId: draft.id,
          ticketUrl: draft.ticketUrl,
          articleTitle: draft.articleTitle,
          articleSummary: draft.articleSummary,
          thumbnailPath,
          destination: 'blogs',
        },
        { anchor, drafts: store, thumbnailOutputDir: outputDir },
      ),
    ).resolves.toBe('https://app.withgauge.com/article-1');
    expect(anchor.publishGaugeArticle).not.toHaveBeenCalled();
  });
});

describe('indexWithGoogleSearchConsole', () => {
  it('requests indexing for the published article URL', async () => {
    const { draft } = await setup();
    const store = new MemoryDraftStore({
      ...draft,
      publishedArticleUrl: 'https://app.withgauge.com/article-1',
    });
    const anchor = {
      requestSearchConsoleIndexing: vi.fn().mockResolvedValue({
        requested: true,
        message: 'Indexing requested',
      }),
    } as unknown as AnchorClient;

    await expect(
      indexWithGoogleSearchConsole(config, draft.id, 'https://app.withgauge.com/article-1', {
        anchor,
        drafts: store,
      }),
    ).resolves.toEqual({
      articleUrl: 'https://app.withgauge.com/article-1',
      indexingRequested: true,
      indexingMessage: 'Indexing requested',
    });
    expect(anchor.requestSearchConsoleIndexing).toHaveBeenCalledWith(
      'search-app',
      'search-identity',
      'search-console-request-indexing',
      'https://app.withgauge.com/article-1',
    );
  });

  it('returns the stored indexing result without requesting twice', async () => {
    const { draft } = await setup();
    const store = new MemoryDraftStore({
      ...draft,
      status: 'published',
      publishedArticleUrl: 'https://app.withgauge.com/article-1',
      indexingRequested: true,
      indexingMessage: 'Already indexed',
    });
    const anchor = {
      requestSearchConsoleIndexing: vi.fn(),
    } as unknown as AnchorClient;

    await expect(
      indexWithGoogleSearchConsole(config, draft.id, 'https://app.withgauge.com/article-1', {
        anchor,
        drafts: store,
      }),
    ).resolves.toEqual({
      articleUrl: 'https://app.withgauge.com/article-1',
      indexingRequested: true,
      indexingMessage: 'Already indexed',
    });
    expect(anchor.requestSearchConsoleIndexing).not.toHaveBeenCalled();
  });
});
