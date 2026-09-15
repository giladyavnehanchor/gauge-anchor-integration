import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { MonitorState, StateEntry, StateStore } from './types.js';

function isStateEntry(value: unknown): value is StateEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    (entry.condition === 'healthy' ||
      entry.condition === 'missing' ||
      entry.condition === 'stale' ||
      entry.condition === 'pending') &&
    typeof entry.applicationId === 'string' &&
    (entry.identityId === undefined || typeof entry.identityId === 'string') &&
    (entry.lastNotifiedCondition === undefined ||
      entry.lastNotifiedCondition === 'healthy' ||
      entry.lastNotifiedCondition === 'missing' ||
      entry.lastNotifiedCondition === 'stale' ||
      entry.lastNotifiedCondition === 'pending') &&
    typeof entry.updatedAt === 'string'
  );
}

function parseState(value: unknown): MonitorState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => isStateEntry(entry)),
  ) as MonitorState;
}

export class MemoryStateStore implements StateStore {
  private readonly values = new Map<string, StateEntry>();

  async get(key: string): Promise<StateEntry | undefined> {
    return this.values.get(key);
  }

  async put(key: string, entry: StateEntry): Promise<void> {
    this.values.set(key, entry);
  }
}

export class NodeFileStateStore implements StateStore {
  constructor(private readonly filePath: string) {}

  async get(key: string): Promise<StateEntry | undefined> {
    const state = await this.read();
    return state[key];
  }

  async put(key: string, entry: StateEntry): Promise<void> {
    const state = await this.read();
    state[key] = entry;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  private async read(): Promise<MonitorState> {
    try {
      return parseState(JSON.parse(await readFile(this.filePath, 'utf8')) as unknown);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
      throw new Error(
        `Unable to read state file ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export interface KvNamespace {
  get<T>(key: string, type: 'json'): Promise<T | null>;
  put(key: string, value: string): Promise<void>;
}

export class CloudflareKvStateStore implements StateStore {
  constructor(
    private readonly namespace: KvNamespace,
    private readonly prefix = 'identity-monitor:',
  ) {}

  async get(key: string): Promise<StateEntry | undefined> {
    const value = await this.namespace.get<unknown>(`${this.prefix}${key}`, 'json');
    return isStateEntry(value) ? value : undefined;
  }

  async put(key: string, entry: StateEntry): Promise<void> {
    await this.namespace.put(`${this.prefix}${key}`, JSON.stringify(entry));
  }
}
