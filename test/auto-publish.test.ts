import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cancelAutoPublish, resumeAutoPublish, scheduleAutoPublish } from '../src/auto-publish.js';
import { createFakeApp, healthyGauge, healthySearchConsole, readyDraft, type FakeApp } from './fakes.js';

const ARTICLE_URL = 'https://anchorbrowser.io/blog/article-1';

async function setup(delayMs = 30): Promise<FakeApp> {
  const outputDir = await mkdtemp(join(tmpdir(), 'anchor-auto-publish-'));
  const first = join(outputDir, 'thumbnail-1.png');
  const second = join(outputDir, 'thumbnail-2.png');
  await writeFile(first, Buffer.from('one'));
  await writeFile(second, Buffer.from('two'));
  const app = createFakeApp({ thumbnailOutputDir: outputDir, autoPublishDelayMs: delayMs });
  await app.drafts.put(readyDraft({
    thumbnails: [
      { title: 'Editorial hero', titleText: 'Short Title Text', prompt: 'prompt', filePath: first },
      { title: 'Conceptual visual', titleText: 'Short Title Text', prompt: 'prompt', filePath: second },
    ],
  }));
  healthyGauge(app);
  healthySearchConsole(app);
  app.anchor.taskResults['gauge-publish-article'] = ARTICLE_URL;
  app.anchor.taskResults['search-console-request-indexing'] = { requested: true, message: 'Indexing requested' };
  return app;
}

function settle(ms = 80): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('auto-publish', () => {
  it('publishes to blogs with the first thumbnail when nobody interacts before the deadline', async () => {
    const app = await setup();

    const scheduled = await scheduleAutoPublish(app, (await app.drafts.get('draft-1'))!);
    expect(Date.parse(scheduled.autoPublishAt!)).toBeGreaterThan(Date.now());

    await vi.waitFor(() => expect(app.slack.results).toHaveLength(1));

    const publishRun = app.anchor.taskRuns.find(({ task }) => task === 'gauge-publish-article');
    expect(publishRun?.options.inputs).toMatchObject({ destination: 'blogs' });
    expect(publishRun?.options.files?.thumbnail_file).toMatchObject({ fileName: 'thumbnail-1.png' });
    expect(app.slack.texts[0]).toContain('publishing it automatically to blogs with thumbnail 1 (Editorial hero)');
    expect(app.slack.results[0]).toMatchObject({ result: { articleUrl: ARTICLE_URL, indexingRequested: true } });
    await expect(app.drafts.get('draft-1')).resolves.toMatchObject({
      status: 'published',
      selectedThumbnailIndex: 0,
      selectedDestination: 'blogs',
    });
    expect((await app.drafts.get('draft-1'))?.autoPublishAt).toBeUndefined();
  });

  it('does nothing when an interaction cancelled the countdown', async () => {
    const app = await setup();
    const scheduled = await scheduleAutoPublish(app, (await app.drafts.get('draft-1'))!);

    const cancelled = await cancelAutoPublish(app, scheduled);
    expect(cancelled.autoPublishAt).toBeUndefined();
    await settle();

    expect(app.anchor.taskRuns).toHaveLength(0);
    expect(app.slack.texts).toHaveLength(0);
    await expect(app.drafts.get('draft-1')).resolves.toMatchObject({ status: 'ready' });
  });

  it('is disabled when the delay is zero', async () => {
    const app = await setup(0);

    const draft = await scheduleAutoPublish(app, (await app.drafts.get('draft-1'))!);
    await settle();

    expect(draft.autoPublishAt).toBeUndefined();
    expect(app.anchor.taskRuns).toHaveLength(0);
  });

  it('reports an automatic publish that fails', async () => {
    const app = await setup();
    app.anchor.identities['app-gauge'] = [];

    await scheduleAutoPublish(app, (await app.drafts.get('draft-1'))!);
    await vi.waitFor(() => expect(app.slack.texts).toHaveLength(2));

    expect(app.slack.texts[1]).toContain('Automatic publishing failed for "A Gauge article": Gauge identity is missing');
    expect(app.slack.results).toHaveLength(0);
  });

  it('re-arms countdowns that were pending when the process restarted', async () => {
    const app = await setup();
    const draft = (await app.drafts.get('draft-1'))!;
    await app.drafts.put({ ...draft, autoPublishAt: new Date(Date.now() - 1000).toISOString() });
    await app.drafts.put(readyDraft({ id: 'draft-2', status: 'published' }));

    await expect(resumeAutoPublish(app)).resolves.toBe(1);
    await vi.waitFor(() => expect(app.slack.results).toHaveLength(1));

    expect(app.slack.results[0]?.draft.id).toBe('draft-1');
  });
});
