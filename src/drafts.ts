import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DiscoveryDraft } from './types.js';

type DraftMap = Record<string, DiscoveryDraft>;

export interface DraftStore {
  get(id: string): Promise<DiscoveryDraft | undefined>;
  put(draft: DiscoveryDraft): Promise<void>;
}

export class NodeFileDraftStore implements DraftStore {
  constructor(private readonly filePath: string) {}

  async get(id: string): Promise<DiscoveryDraft | undefined> {
    const drafts = await this.read();
    return drafts[id];
  }

  async put(draft: DiscoveryDraft): Promise<void> {
    const drafts = await this.read();
    drafts[draft.id] = draft;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(drafts, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  private async read(): Promise<DraftMap> {
    try {
      const value = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
      return Object.fromEntries(
        Object.entries(value).filter(([, draft]) => this.isDraft(draft)),
      ) as DraftMap;
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
      throw new Error(
        `Unable to read draft file ${this.filePath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  private isDraft(value: unknown): value is DiscoveryDraft {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const draft = value as Record<string, unknown>;
    return (
      typeof draft.id === 'string' &&
      typeof draft.createdAt === 'string' &&
      !!draft.application &&
      typeof draft.application === 'object' &&
      !!draft.content &&
      typeof draft.content === 'object' &&
      typeof draft.applicationId === 'string' &&
      typeof draft.identityId === 'string' &&
      typeof draft.ticketUrl === 'string' &&
      typeof draft.articleTitle === 'string' &&
      typeof draft.articleSummary === 'string' &&
      Array.isArray(draft.thumbnails)
    );
  }
}
