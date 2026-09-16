import { readFile } from 'node:fs/promises';
import { basename, extname, resolve } from 'node:path';
import type { App } from './app.js';
import { ensureIdentity, requireIdentity } from './identity.js';
import { gaugePublishArticle, searchConsoleRequestIndexing } from './tasks.js';
import type {
  AnchorFile,
  DiscoveryDraft,
  Identity,
  PublishChoice,
  PublishDestination,
  PublishResult,
} from './types.js';

interface Indexing {
  requested: boolean;
  message: string;
}

const inFlight = new Set<string>();

/** Publishes through Gauge, then asks Search Console to index. Only Gauge is required; indexing can be retried later. */
export async function publish(app: App, draftId: string, choice: PublishChoice): Promise<PublishResult> {
  const draft = await loadDraft(app, draftId);
  if (draft.status === 'published') return publishedResult(draft);
  const thumbnail = await loadThumbnail(app, draft, choice.thumbnailPath);

  inFlight.add(draft.id);
  try {
    const gauge = await requireIdentity(app, 'gauge');
    const articleUrl = await publishArticle(app, draft, gauge, choice.destination, thumbnail);
    const indexing = await requestIndexing(app, articleUrl);
    return markPublished(app, draft, articleUrl, indexing);
  } finally {
    inFlight.delete(draft.id);
  }
}

/** Runs only the Search Console step for an article that Gauge already published. */
export async function indexPublishedArticle(app: App, draftId: string): Promise<PublishResult> {
  const draft = await loadDraft(app, draftId);
  if (!draft.publishedArticleUrl) throw new Error(`Draft ${draft.id} has not been published yet`);
  if (draft.indexingRequested) return publishedResult(draft);

  inFlight.add(draft.id);
  try {
    const indexing = await requestIndexing(app, draft.publishedArticleUrl);
    return markPublished(app, draft, draft.publishedArticleUrl, indexing);
  } finally {
    inFlight.delete(draft.id);
  }
}

async function loadDraft(app: App, draftId: string): Promise<DiscoveryDraft> {
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
  gauge: Identity,
  destination: PublishDestination,
  thumbnail: AnchorFile,
): Promise<string> {
  if (draft.publishedArticleUrl) return draft.publishedArticleUrl;

  app.log('Publishing Gauge article', { draftId: draft.id, destination });
  const articleUrl = await app.anchor.runTask(gaugePublishArticle, {
    applicationId: gauge.application.id,
    identityId: gauge.identityId,
    inputs: {
      ticket_url: draft.article.ticketUrl,
      article_title: draft.article.title,
      destination,
      author: app.config.publishAuthor,
    },
    files: { thumbnail_file: thumbnail },
  });
  await app.drafts.put({ ...draft, publishedArticleUrl: articleUrl });
  app.log('Gauge article published', { draftId: draft.id, articleUrl });
  return articleUrl;
}

/** Never throws: the article is already live, so indexing problems are reported and retried from Slack. */
async function requestIndexing(app: App, articleUrl: string): Promise<Indexing> {
  const searchConsole = await ensureIdentity(app, 'search-console');
  if (!searchConsole) {
    return {
      requested: false,
      message: 'not requested; the Google Search Console identity needs re-authentication in Anchor',
    };
  }
  try {
    const indexing = await app.anchor.runTask(searchConsoleRequestIndexing, {
      applicationId: searchConsole.application.id,
      identityId: searchConsole.identityId,
      inputs: { article_url: articleUrl },
    });
    app.log('Search Console indexing requested', { articleUrl, ...indexing });
    return indexing;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    app.log('Search Console indexing failed', { articleUrl, error: message });
    return { requested: false, message: `failed: ${message}` };
  }
}

async function markPublished(
  app: App,
  draft: DiscoveryDraft,
  articleUrl: string,
  indexing: Indexing,
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
