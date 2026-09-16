import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DiscoveryDraft, DraftStore } from './types.js';

type DraftMap = Record<string, DiscoveryDraft>;

function isDraft(value: unknown): value is DiscoveryDraft {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const draft = value as Record<string, unknown>;
  return (
    typeof draft.id === 'string' &&
    typeof draft.createdAt === 'string' &&
    !!draft.application && typeof draft.application === 'object' &&
    typeof draft.identityId === 'string' &&
    !!draft.article && typeof draft.article === 'object' &&
    Array.isArray(draft.thumbnails) &&
    (draft.status === 'ready' || draft.status === 'published')
  );
}

export class MemoryDraftStore implements DraftStore {
  private readonly drafts = new Map<string, DiscoveryDraft>();

  constructor(...drafts: DiscoveryDraft[]) {
    for (const draft of drafts) this.drafts.set(draft.id, draft);
  }

  async get(id: string): Promise<DiscoveryDraft | undefined> {
    return this.drafts.get(id);
  }

  async put(draft: DiscoveryDraft): Promise<void> {
    this.drafts.set(draft.id, draft);
  }

  async list(): Promise<DiscoveryDraft[]> {
    return [...this.drafts.values()];
  }
}

export class NodeFileDraftStore implements DraftStore {
  constructor(private readonly filePath: string) {}

  async get(id: string): Promise<DiscoveryDraft | undefined> {
    return (await this.read())[id];
  }

  async put(draft: DiscoveryDraft): Promise<void> {
    const drafts = await this.read();
    drafts[draft.id] = draft;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(drafts, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  async list(): Promise<DiscoveryDraft[]> {
    return Object.values(await this.read());
  }

  private async read(): Promise<DraftMap> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(Object.entries(value).filter(([, draft]) => isDraft(draft))) as DraftMap;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
      throw new Error(
        `Unable to read draft file ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
