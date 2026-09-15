import { randomUUID } from 'node:crypto';
import type { App } from './app.js';
import { ensureIdentity } from './identity.js';
import { gaugeFindArticle } from './tasks.js';
import type { Article, DiscoveryDraft, Identity } from './types.js';

export async function discover(app: App): Promise<DiscoveryDraft | undefined> {
  const gauge = await ensureIdentity(app, 'gauge');
  if (!gauge) return undefined;

  const article = await findArticleToWrite(app, gauge);
  if (!article) return undefined;

  const draft = await prepareDraft(app, gauge, article);
  await sendDraftToSlack(app, draft);
  return draft;
}

async function findArticleToWrite(app: App, gauge: Identity): Promise<Article | null> {
  app.log('Looking for a Gauge article to write', { task: gaugeFindArticle.name });
  const article = await app.anchor.runTask(gaugeFindArticle, {
    applicationId: gauge.application.id,
    identityId: gauge.identityId,
  });
  app.log(article ? 'Gauge article ready for review' : 'No open Gauge write-content ticket', {
    ...(article ? { title: article.title, ticketUrl: article.ticketUrl } : {}),
  });
  return article;
}

async function prepareDraft(app: App, gauge: Identity, article: Article): Promise<DiscoveryDraft> {
  const thumbnails = await app.thumbnails.generate(article.title, article.summary);
  const draft: DiscoveryDraft = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    application: gauge.application,
    identityId: gauge.identityId,
    article,
    thumbnails,
    status: 'ready',
  };
  await app.drafts.put(draft);
  return draft;
}

async function sendDraftToSlack(app: App, draft: DiscoveryDraft): Promise<void> {
  await app.slack.sendDraft(draft);
  app.log('Draft sent to Slack', { draftId: draft.id, title: draft.article.title });
}
