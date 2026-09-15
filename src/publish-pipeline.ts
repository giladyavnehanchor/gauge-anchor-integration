import { basename, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { DraftStore } from './drafts.js';
import type {
  AnchorClient,
  DiscoveryDraft,
  MonitorConfig,
  PublishRequest,
  PublishResult,
} from './types.js';

interface PublishDependencies {
  anchor: AnchorClient;
  drafts: DraftStore;
  thumbnailOutputDir: string;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

const activePublishes = new Set<string>();

function assertDestination(value: string): PublishRequest['destination'] {
  if (value === 'blogs' || value === 'templates hubs' || value === 'guides') {
    return value;
  }
  throw new Error('destination must be blogs, templates hubs, or guides');
}

function thumbnailMimeType(path: string): string {
  if (path.toLocaleLowerCase().endsWith('.jpg') || path.toLocaleLowerCase().endsWith('.jpeg')) {
    return 'image/jpeg';
  }
  if (path.toLocaleLowerCase().endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

function safeThumbnailPath(outputDir: string, thumbnailPath: string): string {
  const root = resolve(outputDir);
  const path = resolve(thumbnailPath);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error('thumbnailPath must point inside the configured thumbnail output directory');
  }
  return path;
}

async function loadDraft(drafts: DraftStore, draftId: string | undefined): Promise<DiscoveryDraft> {
  if (!draftId) {
    throw new Error('draftId is required for an idempotent publish');
  }
  const draft = await drafts.get(draftId);
  if (!draft) throw new Error(`Discovery draft ${draftId} was not found`);
  return draft;
}

export async function publishDraft(
  config: MonitorConfig,
  request: PublishRequest,
  dependencies: PublishDependencies,
): Promise<string> {
  const draft = await loadDraft(dependencies.drafts, request.draftId);
  if (draft.publishedArticleUrl) return draft.publishedArticleUrl;
  if (activePublishes.has(draft.id)) {
    throw new Error(`Draft ${draft.id} is already being published`);
  }
  activePublishes.add(draft.id);

  try {
    const thumbnailPath = safeThumbnailPath(
      dependencies.thumbnailOutputDir,
      request.thumbnailPath,
    );
    if (!draft.thumbnails.some((thumbnail) => thumbnail.filePath === thumbnailPath)) {
      throw new Error('thumbnailPath is not one of the thumbnails generated for this draft');
    }

    const input: PublishRequest = {
      draftId: draft.id,
      ticketUrl: draft.ticketUrl,
      articleTitle: draft.articleTitle,
      articleSummary: draft.articleSummary,
      thumbnailPath,
      destination: assertDestination(request.destination),
    };
    const thumbnail = {
      fileName: basename(thumbnailPath),
      mimeType: thumbnailMimeType(thumbnailPath),
      data: new Uint8Array(await readFile(thumbnailPath)),
    };

    dependencies.log?.('Gauge publish workflow started', {
      draftId: draft.id,
      ticketUrl: input.ticketUrl,
      destination: input.destination,
      thumbnailPath,
    });
    const articleUrl = await dependencies.anchor.publishGaugeArticle(
      draft.applicationId,
      draft.identityId,
      config.gaugePublishTaskName,
      input,
      thumbnail,
    );
    await dependencies.drafts.put({
      ...draft,
      publishedArticleUrl: articleUrl,
    });
    dependencies.log?.('Gauge article published', { draftId: draft.id, articleUrl });
    return articleUrl;
  } finally {
    activePublishes.delete(draft.id);
  }
}

export async function indexWithGoogleSearchConsole(
  config: MonitorConfig,
  draftId: string,
  articleUrl: string,
  dependencies: Pick<PublishDependencies, 'anchor' | 'drafts' | 'log'> & {
    searchConsoleApplicationId?: string;
    searchConsoleIdentityId?: string;
  },
): Promise<PublishResult> {
  const draft = await loadDraft(dependencies.drafts, draftId);
  if (
    draft.status === 'published' &&
    draft.publishedArticleUrl &&
    draft.indexingRequested !== undefined &&
    draft.indexingMessage
  ) {
    return {
      articleUrl: draft.publishedArticleUrl,
      indexingRequested: draft.indexingRequested,
      indexingMessage: draft.indexingMessage,
    };
  }

  const indexing = await dependencies.anchor.requestSearchConsoleIndexing(
    dependencies.searchConsoleApplicationId ?? draft.searchConsoleApplicationId,
    dependencies.searchConsoleIdentityId ?? draft.searchConsoleIdentityId,
    config.searchConsoleIndexTaskName,
    articleUrl,
  );
  const result: PublishResult = {
    articleUrl,
    indexingRequested: indexing.requested,
    indexingMessage: indexing.message,
  };
  await dependencies.drafts.put({
    ...draft,
    status: 'published',
    publishedArticleUrl: result.articleUrl,
    indexingRequested: result.indexingRequested,
    indexingMessage: result.indexingMessage,
  });
  dependencies.log?.('Publish workflow completed', {
    draftId: draft.id,
    articleUrl,
    indexingRequested: result.indexingRequested,
  });
  return result;
}
