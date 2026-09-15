import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { App } from './app.js';
import { requireIdentity } from './identity.js';
import { gaugePublishArticle, searchConsoleRequestIndexing } from './tasks.js';
import type {
  AnchorFile,
  DiscoveryDraft,
  Identity,
  PublishChoice,
  PublishDestination,
  PublishResult,
} from './types.js';

const inFlight = new Set<string>();

export async function publish(app: App, draftId: string, choice: PublishChoice): Promise<PublishResult> {
  const draft = await loadPublishableDraft(app, draftId);
  if (draft.status === 'published') return publishedResult(draft);
  const thumbnail = await loadThumbnail(app, draft, choice.thumbnailPath);

  inFlight.add(draft.id);
  try {
    const searchConsole = await requireIdentity(app, 'search-console');
    const articleUrl = await publishArticle(app, draft, choice.destination, thumbnail);
    const indexing = await requestIndexing(app, searchConsole, articleUrl);
    return markPublished(app, draft, articleUrl, indexing);
  } finally {
    inFlight.delete(draft.id);
  }
}

async function loadPublishableDraft(app: App, draftId: string): Promise<DiscoveryDraft> {
  const draft = await app.drafts.get(draftId);
  if (!draft) throw new Error(`Discovery draft ${draftId} was not found`);
  if (inFlight.has(draft.id)) throw new Error(`Draft ${draft.id} is already being published`);
  return draft;
}

function publishedResult(draft: DiscoveryDraft): PublishResult {
  if (!draft.publishedArticleUrl || draft.indexingRequested === undefined || !draft.indexingMessage) {
    throw new Error(`Draft ${draft.id} is marked published but has no publish result`);
  }
  return {
    articleUrl: draft.publishedArticleUrl,
    indexingRequested: draft.indexingRequested,
    indexingMessage: draft.indexingMessage,
  };
}

async function publishArticle(
  app: App,
  draft: DiscoveryDraft,
  destination: PublishDestination,
  thumbnail: AnchorFile,
): Promise<string> {
  if (draft.publishedArticleUrl) return draft.publishedArticleUrl;

  app.log('Publishing Gauge article', { draftId: draft.id, destination });
  const articleUrl = await app.anchor.runTask(gaugePublishArticle, {
    applicationId: draft.application.id,
    identityId: draft.identityId,
    inputs: {
      ticket_url: draft.article.ticketUrl,
      article_title: draft.article.title,
      article_summary: draft.article.summary,
      destination,
      author: app.config.publishAuthor,
    },
    file: thumbnail,
  });
  await app.drafts.put({ ...draft, publishedArticleUrl: articleUrl });
  app.log('Gauge article published', { draftId: draft.id, articleUrl });
  return articleUrl;
}

async function requestIndexing(
  app: App,
  searchConsole: Identity,
  articleUrl: string,
): Promise<{ requested: boolean; message: string }> {
  const indexing = await app.anchor.runTask(searchConsoleRequestIndexing, {
    applicationId: searchConsole.application.id,
    identityId: searchConsole.identityId,
    inputs: { article_url: articleUrl },
  });
  app.log('Search Console indexing requested', { articleUrl, ...indexing });
  return indexing;
}

async function markPublished(
  app: App,
  draft: DiscoveryDraft,
  articleUrl: string,
  indexing: { requested: boolean; message: string },
): Promise<PublishResult> {
  await app.drafts.put({
    ...draft,
    status: 'published',
    publishedArticleUrl: articleUrl,
    indexingRequested: indexing.requested,
    indexingMessage: indexing.message,
  });
  return { articleUrl, indexingRequested: indexing.requested, indexingMessage: indexing.message };
}

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.png': 'image/png',
};

async function loadThumbnail(app: App, draft: DiscoveryDraft, thumbnailPath: string): Promise<AnchorFile> {
  const root = resolve(app.config.thumbnailOutputDir);
  const path = resolve(thumbnailPath);
  if (path !== root && !path.startsWith(`${root}/`)) {
    throw new Error('thumbnailPath must point inside the configured thumbnail output directory');
  }
  if (!draft.thumbnails.some((thumbnail) => thumbnail.filePath === path)) {
    throw new Error('thumbnailPath is not one of the thumbnails generated for this draft');
  }
  return {
    fileName: basename(path),
    mimeType: MIME_TYPES[extname(path).toLocaleLowerCase()] ?? 'image/png',
    data: new Uint8Array(await readFile(path)),
  };
}
