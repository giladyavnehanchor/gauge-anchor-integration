import { describe, expect, it, vi } from 'vitest';
import { handleSlackInteraction } from '../src/slack-interactions.js';
import { article, createFakeApp, healthyGauge, readyDraft } from './fakes.js';

function payload(action: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel: { id: 'C1' },
    message: { ts: '1.0' },
    user: { id: 'U1' },
    actions: [action],
    ...extra,
  };
}

function flush(texts: string[]): Promise<void> {
  return vi.waitFor(() => expect(texts.length).toBeGreaterThan(0));
}

describe('handleSlackInteraction', () => {
  it('records the selected thumbnail and updates the message', async () => {
    const app = createFakeApp();
    await app.drafts.put(readyDraft());

    const reply = await handleSlackInteraction(app, payload({
      action_id: 'thumbnail-select-1',
      value: JSON.stringify({ draftId: 'draft-1', index: 1 }),
    }));

    expect(reply.text).toBe('Selected thumbnail 2.');
    expect(app.slack.updates[0]?.selectedThumbnailIndex).toBe(1);
    await expect(app.drafts.get('draft-1')).resolves.toMatchObject({ selectedThumbnailIndex: 1 });
  });

  it('records the destination using the block id when the action has no value', async () => {
    const app = createFakeApp();
    await app.drafts.put(readyDraft());

    const reply = await handleSlackInteraction(app, payload({
      action_id: 'destination-select',
      block_id: 'destination-selection:draft-1',
      selected_option: { value: 'guides' },
    }));

    expect(reply.text).toBe('Selected destination: guides.');
    await expect(app.drafts.get('draft-1')).resolves.toMatchObject({ selectedDestination: 'guides' });
  });

  it('refuses to publish until a thumbnail and destination are chosen', async () => {
    const app = createFakeApp();
    await app.drafts.put(readyDraft());

    const reply = await handleSlackInteraction(app, payload({
      action_id: 'publish-article',
      value: JSON.stringify({ draftId: 'draft-1' }),
    }));

    expect(reply.text).toBe('Choose a thumbnail and destination before posting.');
  });

  it('starts publishing in the background and reports the result to the channel', async () => {
    const app = createFakeApp();
    await app.drafts.put(readyDraft({ selectedThumbnailIndex: 0, selectedDestination: 'blogs' }));
    app.anchor.identities['app-search-console'] = [];

    const reply = await handleSlackInteraction(app, payload({
      action_id: 'publish-article',
      value: JSON.stringify({ draftId: 'draft-1' }),
    }));
    await flush(app.slack.texts);

    expect(reply.text).toBe('Publishing started for <@U1>.');
    expect(app.slack.texts[0]).toContain('Publishing failed for A Gauge article');
    expect(app.slack.texts[0]).toContain('/tmp/one.png');
  });

  it('runs discovery in the background from the retry button', async () => {
    const app = createFakeApp();
    healthyGauge(app);
    app.anchor.taskResults['gauge-content-research-outline-draft'] = article;

    const reply = await handleSlackInteraction(app, payload(
      { action_id: 'run-discovery', value: JSON.stringify({ target: 'gauge' }) },
      { message: undefined },
    ));
    await flush(app.slack.texts);

    expect(reply.text).toContain('Discovery started');
    expect(app.slack.drafts).toHaveLength(1);
    expect(app.slack.texts[0]).toBe('Discovery finished. Draft created for "A Gauge article".');
  });

  it('answers clicks on stale messages politely and rejects unknown actions', async () => {
    const app = createFakeApp();

    await expect(
      handleSlackInteraction(app, payload({ action_id: 'thumbnail-select-0', value: JSON.stringify({ draftId: 'nope' }) })),
    ).resolves.toMatchObject({ response_type: 'ephemeral', text: expect.stringContaining('no longer available') });

    await app.drafts.put(readyDraft());
    await expect(
      handleSlackInteraction(app, payload({ action_id: 'mystery', value: JSON.stringify({ draftId: 'draft-1' }) })),
    ).rejects.toThrow('Unsupported Slack action: mystery');
  });
});
