import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HttpAnchorClient } from './anchor.js';
import { readConfig } from './config.js';
import { NodeFileDraftStore } from './drafts.js';
import { SlackWebhookClient } from './slack.js';
import { NodeFileStateStore } from './state.js';
import { HttpThumbnailClient } from './thumbnails.js';
import type {
  AnchorClient,
  Config,
  DraftStore,
  Log,
  SlackClient,
  StateStore,
  ThumbnailClient,
} from './types.js';

export interface App {
  config: Config;
  anchor: AnchorClient;
  slack: SlackClient;
  thumbnails: ThumbnailClient;
  drafts: DraftStore;
  state: StateStore;
  log: Log;
}

export function createApp(config: Config = readConfig()): App {
  const log: Log = (message, details) => console.log(message, details ?? '');
  const readBytes = async (path: string) => new Uint8Array(await readFile(path));
  const saveImage = async (fileName: string, base64: string) => {
    await mkdir(config.thumbnailOutputDir, { recursive: true });
    const filePath = resolve(config.thumbnailOutputDir, fileName);
    await writeFile(filePath, Buffer.from(base64, 'base64'));
    return filePath;
  };

  return {
    config,
    log,
    anchor: new HttpAnchorClient(config),
    slack: new SlackWebhookClient(config, fetch, log, readBytes),
    thumbnails: new HttpThumbnailClient(config, fetch, saveImage, log),
    drafts: new NodeFileDraftStore(config.draftFile),
    state: new NodeFileStateStore(config.stateFile),
  };
}
