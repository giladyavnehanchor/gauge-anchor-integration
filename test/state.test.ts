import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NodeFileDraftStore } from '../src/drafts.js';
import { MemoryStateStore, NodeFileStateStore } from '../src/state.js';
import type { StateEntry } from '../src/types.js';
import { readyDraft } from './fakes.js';

const entry: StateEntry = {
  condition: 'stale',
  applicationId: 'app-1',
  identityId: 'identity-1',
  lastNotifiedCondition: 'stale',
  updatedAt: '2030-01-01T00:00:00.000Z',
};

describe('stores', () => {
  it('keeps state isolated in memory for tests', async () => {
    const store = new MemoryStateStore();
    await store.put('key', entry);

    await expect(store.get('key')).resolves.toEqual(entry);
  });

  it('persists state to a JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anchor-state-'));
    const store = new NodeFileStateStore(join(dir, 'nested', 'state.json'));

    await expect(store.get('gauge:app-1')).resolves.toBeUndefined();
    await store.put('gauge:app-1', entry);

    await expect(new NodeFileStateStore(join(dir, 'nested', 'state.json')).get('gauge:app-1')).resolves.toEqual(entry);
  });

  it('persists drafts to a JSON file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'anchor-drafts-'));
    const store = new NodeFileDraftStore(join(dir, 'drafts.json'));
    const draft = readyDraft();

    await store.put(draft);
    await store.put({ ...draft, selectedDestination: 'guides' });

    await expect(store.get('draft-1')).resolves.toEqual({ ...draft, selectedDestination: 'guides' });
    await expect(store.get('missing')).resolves.toBeUndefined();
  });
});
