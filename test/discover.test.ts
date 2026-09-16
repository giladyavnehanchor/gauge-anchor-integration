import { describe, expect, it } from 'vitest';
import { discover } from '../src/discover.js';
import { article, createFakeApp, healthyGauge, thumbnails } from './fakes.js';

describe('discover', () => {
  it('skips discovery when the Gauge identity is not healthy', async () => {
    const app = createFakeApp();

    await expect(discover(app)).resolves.toBeUndefined();
    expect(app.anchor.taskRuns).toHaveLength(0);
    expect(app.slack.drafts).toHaveLength(0);
  });

  it('does nothing when Gauge has no open write-content ticket', async () => {
    const app = createFakeApp();
    healthyGauge(app);
    app.anchor.taskResults['gauge-content-research-outline-draft'] = null;

    await expect(discover(app)).resolves.toBeUndefined();
    expect(app.slack.drafts).toHaveLength(0);
  });

  it('finds an article, prepares a draft, and sends it to Slack', async () => {
    const app = createFakeApp();
    healthyGauge(app);
    app.anchor.taskResults['gauge-content-research-outline-draft'] = article;

    const draft = await discover(app);

    expect(draft).toMatchObject({ article, thumbnails, status: 'ready', identityId: 'identity-gauge' });
    expect(app.anchor.taskRuns.map(({ task }) => task)).toEqual([
      'anchor-identity-monitor-gauge-dom-check',
      'gauge-content-research-outline-draft',
    ]);
    await expect(app.drafts.get(draft?.id ?? '')).resolves.toEqual(draft);
    expect(app.slack.drafts).toEqual([draft]);
  });

  it('starts the auto-publish countdown once the draft is in Slack', async () => {
    const app = createFakeApp({ autoPublishDelayMs: 900_000 });
    healthyGauge(app);
    app.anchor.taskResults['gauge-content-research-outline-draft'] = article;

    const draft = await discover(app);

    expect(draft?.autoPublishAt).toBeDefined();
    expect(app.slack.drafts[0]?.autoPublishAt).toBeUndefined();
    await expect(app.drafts.get(draft?.id ?? '')).resolves.toMatchObject({ autoPublishAt: draft?.autoPublishAt });
  });

  it('runs even when the Search Console identity is missing', async () => {
    const app = createFakeApp();
    healthyGauge(app);
    app.anchor.taskResults['gauge-content-research-outline-draft'] = article;

    await expect(discover(app)).resolves.toBeDefined();
    expect(app.anchor.taskRuns.some(({ task }) => task.includes('search-console'))).toBe(false);
  });
});
