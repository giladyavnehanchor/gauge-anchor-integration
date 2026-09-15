import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { publish } from '../src/publish.js';
import { createFakeApp, healthySearchConsole, readyDraft, type FakeApp } from './fakes.js';

async function setup(): Promise<{ app: FakeApp; thumbnailPath: string }> {
  const outputDir = await mkdtemp(join(tmpdir(), 'anchor-publish-'));
  const thumbnailPath = join(outputDir, 'thumbnail-1.png');
  await writeFile(thumbnailPath, Buffer.from('thumbnail'));
  const app = createFakeApp({ thumbnailOutputDir: outputDir });
  await app.drafts.put(readyDraft({ thumbnails: [{ title: 'Option 1', prompt: 'prompt', filePath: thumbnailPath }] }));
  healthySearchConsole(app);
  app.anchor.taskResults['gauge-publish-article'] = 'https://anchorbrowser.io/blog/article-1';
  app.anchor.taskResults['search-console-request-indexing'] = { requested: true, message: 'Indexing requested' };
  return { app, thumbnailPath };
}

describe('publish', () => {
  it('publishes the selected thumbnail and requests indexing', async () => {
    const { app, thumbnailPath } = await setup();

    await expect(publish(app, 'draft-1', { thumbnailPath, destination: 'blogs' })).resolves.toEqual({
      articleUrl: 'https://anchorbrowser.io/blog/article-1',
      indexingRequested: true,
      indexingMessage: 'Indexing requested',
    });

    const [, publishRun, indexRun] = app.anchor.taskRuns;
    expect(publishRun).toMatchObject({
      task: 'gauge-publish-article',
      options: {
        applicationId: 'app-gauge',
        identityId: 'identity-gauge',
        inputs: expect.objectContaining({ destination: 'blogs', author: 'Idan Raman' }),
        files: { thumbnail_file: expect.objectContaining({ fileName: 'thumbnail-1.png', mimeType: 'image/png' }) },
      },
    });
    expect(indexRun).toMatchObject({
      task: 'search-console-request-indexing',
      options: { identityId: 'identity-search-console', inputs: { article_url: 'https://anchorbrowser.io/blog/article-1' } },
    });
    await expect(app.drafts.get('draft-1')).resolves.toMatchObject({
      status: 'published',
      publishedArticleUrl: 'https://anchorbrowser.io/blog/article-1',
    });
  });

  it('checks the Search Console identity before publishing', async () => {
    const { app, thumbnailPath } = await setup();
    app.anchor.identities['app-search-console'] = [];

    await expect(publish(app, 'draft-1', { thumbnailPath, destination: 'blogs' })).rejects.toThrow(
      'Google Search Console identity is missing',
    );
    expect(app.anchor.taskRuns.some(({ task }) => task === 'gauge-publish-article')).toBe(false);
  });

  it('does not publish twice when the article URL is already stored', async () => {
    const { app, thumbnailPath } = await setup();
    const draft = (await app.drafts.get('draft-1'))!;
    await app.drafts.put({ ...draft, publishedArticleUrl: 'https://anchorbrowser.io/blog/article-1' });

    await publish(app, 'draft-1', { thumbnailPath, destination: 'blogs' });

    expect(app.anchor.taskRuns.some(({ task }) => task === 'gauge-publish-article')).toBe(false);
    expect(app.anchor.taskRuns.some(({ task }) => task === 'search-console-request-indexing')).toBe(true);
  });

  it('returns the stored result for a published draft without any Anchor calls', async () => {
    const { app, thumbnailPath } = await setup();
    const draft = (await app.drafts.get('draft-1'))!;
    await app.drafts.put({
      ...draft,
      status: 'published',
      publishedArticleUrl: 'https://anchorbrowser.io/blog/article-1',
      indexingRequested: true,
      indexingMessage: 'Already indexed',
    });

    await expect(publish(app, 'draft-1', { thumbnailPath, destination: 'blogs' })).resolves.toEqual({
      articleUrl: 'https://anchorbrowser.io/blog/article-1',
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
