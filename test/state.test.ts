import { describe, expect, it } from 'vitest';
import { CloudflareKvStateStore, MemoryStateStore } from '../src/state.js';
import type { StateEntry } from '../src/types.js';

const entry: StateEntry = {
  condition: 'stale',
  applicationId: 'app-1',
  identityId: 'identity-1',
  lastNotifiedCondition: 'stale',
  updatedAt: '2030-01-01T00:00:00.000Z',
};

class FakeKv {
  private readonly values = new Map<string, string>();

  async get<T>(key: string, _type: 'json'): Promise<T | null> {
    const value = this.values.get(key);
    return value ? (JSON.parse(value) as T) : null;
  }

  async put(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
}

describe('state stores', () => {
  it('stores monitor state in Cloudflare KV with a namespace prefix', async () => {
    const kv = new FakeKv();
    const store = new CloudflareKvStateStore(kv);

    await store.put('gauge:app-1', entry);

    await expect(store.get('gauge:app-1')).resolves.toEqual(entry);
    await expect(store.get('missing')).resolves.toBeUndefined();
  });

  it('keeps state isolated in memory for tests', async () => {
    const store = new MemoryStateStore();
    await store.put('key', entry);

    await expect(store.get('key')).resolves.toEqual(entry);
  });
});
