import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { indexPublishedArticle, publish } from '../src/publish.js';
import { createFakeApp, healthyGauge, healthySearchConsole, readyDraft, type FakeApp } from './fakes.js';

const ARTICLE_URL = 'https://anchorbrowser.io/blog/article-1';

async function setup(): Promise<{ app: FakeApp; thumbnailPath: string }> {
  const outputDir = await mkdtemp(join(tmpdir(), 'anchor-publish-'));
  const thumbnailPath = join(outputDir, 'thumbnail-1.png');
  await writeFile(thumbnailPath, Buffer.from('thumbnail'));
  const app = createFakeApp({ thumbnailOutputDir: outputDir });
  await app.drafts.put(readyDraft({ thumbnails: [{ title: 'Option 1', titleText: 'Short Title Text', prompt: 'prompt', filePath: thumbnailPath }] }));
  healthyGauge(app);
  healthySearchConsole(app);
  app.anchor.taskResults['gauge-publish-article'] = ARTICLE_URL;
  app.anchor.taskResults['search-console-request-indexing'] = { requested: true, message: 'Indexing requested' };
  return { app, thumbnailPath };
}

function tasksRun(app: FakeApp): string[] {
  return app.anchor.taskRuns.map(({ task }) => task);
}

describe('publish', () => {
  it('publishes the selected thumbnail and requests indexing', async () => {
    const { app, thumbnailPath } = await setup();

    await expect(publish(app, 'draft-1', { thumbnailPath, destination: 'blogs' })).resolves.toEqual({
      articleUrl: ARTICLE_URL,
      indexingRequested: true,
      indexingMessage: 'Indexing requested',
    });

    expect(tasksRun(app)).toEqual([
      'anchor-identity-monitor-gauge-dom-check',
      'gauge-publish-article',
      'anchor-identity-monitor-search-console-dom-check',
      'search-console-request-indexing',
    ]);
    const [, publishRun, , indexRun] = app.anchor.taskRuns;
    expect(publishRun).toMatchObject({
      options: {
        applicationId: 'app-gauge',
        identityId: 'identity-gauge',
        inputs: expect.objectContaining({ destination: 'blogs', author: 'Idan Raman' }),
        files: { thumbnail_file: expect.objectContaining({ fileName: 'thumbnail-1.png', mimeType: 'image/png' }) },
      },
    });
    expect(indexRun).toMatchObject({
      options: { identityId: 'identity-search-console', inputs: { article_url: ARTICLE_URL } },
    });
    await expect(app.drafts.get('draft-1')).resolves.toMatchObject({ status: 'published', publishedArticleUrl: ARTICLE_URL });
  });

  it('refuses to publish when the Gauge identity is not usable', async () => {
    const { app, thumbnailPath } = await setup();
    app.anchor.identities['app-gauge'] = [];

    await expect(publish(app, 'draft-1', { thumbnailPath, destination: 'blogs' })).rejects.toThrow(
      'Gauge identity is missing or needs re-authentication',
    );
    expect(tasksRun(app)).not.toContain('gauge-publish-article');
    expect(tasksRun(app).some((task) => task.includes('search-console'))).toBe(false);
  });

  it('still publishes through Gauge when the Search Console identity is stale, leaving indexing pending', async () => {
    const { app, thumbnailPath } = await setup();
    app.anchor.taskResults['anchor-identity-monitor-search-console-dom-check'] = false;

    await expect(publish(app, 'draft-1', { thumbnailPath, destination: 'blogs' })).resolves.toEqual({
      articleUrl: ARTICLE_URL,
      indexingRequested: false,
      indexingMessage: 'not requested; the Google Search Console identity needs re-authentication in Anchor',
    });
    expect(tasksRun(app)).toContain('gauge-publish-article');
    expect(tasksRun(app)).not.toContain('search-console-request-indexing');
    expect(app.slack.alerts.map((alert) => alert.target.key)).toEqual(['search-console']);
    await expect(app.drafts.get('draft-1')).resolves.toMatchObject({ status: 'published', indexingRequested: false });
  });

  it('reports an indexing task failure instead of failing the publish', async () => {
    const { app, thumbnailPath } = await setup();
    app.anchor.taskErrors['search-console-request-indexing'] = new Error('Search Console timed out');

    await expect(publish(app, 'draft-1', { thumbnailPath, destination: 'blogs' })).resolves.toEqual({
      articleUrl: ARTICLE_URL,
      indexingRequested: false,
      indexingMessage: 'failed: Search Console timed out',
    });
  });

  it('does not publish twice when the article URL is already stored', async () => {
    const { app, thumbnailPath } = await setup();
    const draft = (await app.drafts.get('draft-1'))!;
    await app.drafts.put({ ...draft, publishedArticleUrl: ARTICLE_URL });

    await publish(app, 'draft-1', { thumbnailPath, destination: 'blogs' });

    expect(tasksRun(app)).not.toContain('gauge-publish-article');
    expect(tasksRun(app)).toContain('search-console-request-indexing');
  });

  it('returns the stored result for a published draft without any Anchor calls', async () => {
    const { app, thumbnailPath } = await setup();
    const draft = (await app.drafts.get('draft-1'))!;
    await app.drafts.put({
      ...draft,
      status: 'published',
      publishedArticleUrl: ARTICLE_URL,
      indexingRequested: true,
      indexingMessage: 'Already indexed',
    });

    await expect(publish(app, 'draft-1', { thumbnailPath, destination: 'blogs' })).resolves.toEqual({
      articleUrl: ARTICLE_URL,
      indexingRequested: true,
      indexingMessage: 'Already indexed',
    });
    expect(app.anchor.taskRuns).toHaveLength(0);
  });

  it('rejects thumbnails outside the output directory or not generated for the draft', async () => {
    const { app, thumbnailPath } = await setup();

    await expect(publish(app, 'draft-1', { thumbnailPath: '/etc/passwd', destination: 'blogs' })).rejects.toThrow(
      'inside the configured thumbnail output directory',
    );
    await expect(
      publish(app, 'draft-1', { thumbnailPath: `${thumbnailPath}.other`, destination: 'blogs' }),
    ).rejects.toThrow('not one of the thumbnails generated for this draft');
  });
});

describe('indexPublishedArticle', () => {
  it('runs only the Search Console task for a published draft with pending indexing', async () => {
    const { app } = await setup();
    const draft = (await app.drafts.get('draft-1'))!;
    await app.drafts.put({
      ...draft,
      status: 'published',
      publishedArticleUrl: ARTICLE_URL,
      indexingRequested: false,
      indexingMessage: 'not requested; the Google Search Console identity needs re-authentication in Anchor',
    });

    await expect(indexPublishedArticle(app, 'draft-1')).resolves.toEqual({
      articleUrl: ARTICLE_URL,
      indexingRequested: true,
      indexingMessage: 'Indexing requested',
    });
    expect(tasksRun(app)).toEqual(['anchor-identity-monitor-search-console-dom-check', 'search-console-request-indexing']);
    await expect(app.drafts.get('draft-1')).resolves.toMatchObject({ indexingRequested: true });
  });

  it('refuses drafts that Gauge has not published and skips drafts already indexed', async () => {
    const { app } = await setup();
    await expect(indexPublishedArticle(app, 'draft-1')).rejects.toThrow('has not been published yet');

    const draft = (await app.drafts.get('draft-1'))!;
    await app.drafts.put({ ...draft, status: 'published', publishedArticleUrl: ARTICLE_URL, indexingRequested: true, indexingMessage: 'done' });
    await expect(indexPublishedArticle(app, 'draft-1')).resolves.toMatchObject({ indexingRequested: true });
    expect(app.anchor.taskRuns).toHaveLength(0);
  });
});
