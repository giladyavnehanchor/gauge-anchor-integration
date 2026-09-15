import type { App } from '../src/app.js';
import { MemoryDraftStore } from '../src/drafts.js';
import { MemoryStateStore } from '../src/state.js';
import type {
  AnchorApplication,
  AnchorClient,
  AnchorIdentity,
  Article,
  Config,
  DiscoveryDraft,
  IdentityAlert,
  IdentityLink,
  RunTaskOptions,
  SlackClient,
  TaskDefinition,
  ThumbnailOption,
} from '../src/types.js';

export const gaugeApplication: AnchorApplication = {
  id: 'app-gauge',
  name: 'Gauge',
  url: 'https://app.withgauge.com',
};

export const searchConsoleApplication: AnchorApplication = {
  id: 'app-search-console',
  name: 'Google Search Console',
  url: 'https://search.google.com/search-console',
};

export const article: Article = {
  ticketUrl: 'https://app.withgauge.com/tasks/ticket-1',
  title: 'A Gauge article',
  summary: 'A concise summary',
  researchCompleted: true,
  outlineCompleted: true,
  articleWritten: true,
  message: 'Stopped before publishing',
};

export const thumbnails: ThumbnailOption[] = [
  { title: 'Option 1', prompt: 'prompt', filePath: '/tmp/one.png' },
  { title: 'Option 2', prompt: 'prompt', filePath: '/tmp/two.png' },
];

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    anchorApiBase: 'https://api.anchorbrowser.io/v1',
    anchorApiKey: 'test-key',
    port: 8787,
    reauthAuthMethod: 'profile',
    notifyRecovery: true,
    requestTimeoutMs: 1000,
    taskTimeoutMs: 1000,
    longTaskTimeoutMs: 1000,
    taskPollIntervalMs: 1,
    thumbnailTimeoutMs: 1000,
    thumbnailOutputDir: '/tmp',
    stateFile: 'state/test.json',
    draftFile: 'state/test-drafts.json',
    publishAuthor: 'Idan Raman',
    targets: [
      { key: 'gauge', label: 'Gauge', applicationName: 'Gauge', applicationUrl: 'https://app.withgauge.com' },
      {
        key: 'search-console',
        label: 'Google Search Console',
        applicationName: 'Google Search Console',
        applicationUrl: 'https://search.google.com/search-console',
      },
    ],
    ...overrides,
  };
}

export class FakeAnchor implements AnchorClient {
  applications: AnchorApplication[] = [gaugeApplication, searchConsoleApplication];
  identities: Record<string, AnchorIdentity[]> = {};
  taskResults: Record<string, unknown> = {};
  taskErrors: Record<string, unknown> = {};
  taskRuns: Array<{ task: string; options: RunTaskOptions }> = [];
  createdApplications = 0;
  identityLinks = 0;
  reauthLinks = 0;

  async listApplications(): Promise<AnchorApplication[]> {
    return this.applications;
  }

  async createApplication(source: string, name: string): Promise<AnchorApplication> {
    this.createdApplications += 1;
    const application = { id: `created-${name}`, name, url: source };
    this.applications = [...this.applications, application];
    return application;
  }

  async listIdentities(applicationId: string): Promise<AnchorIdentity[]> {
    return this.identities[applicationId] ?? [];
  }

  async createIdentityLink(): Promise<IdentityLink> {
    this.identityLinks += 1;
    return { url: 'https://anchor.test/create', expiresAt: '2030-01-01T00:00:00Z' };
  }

  async createReauthLink(): Promise<IdentityLink> {
    this.reauthLinks += 1;
    return { url: 'https://anchor.test/reauth', expiresAt: '2030-01-01T00:00:00Z' };
  }

  async runTask<TOutput>(task: TaskDefinition<TOutput>, options: RunTaskOptions): Promise<TOutput> {
    this.taskRuns.push({ task: task.name, options });
    if (task.name in this.taskErrors) throw this.taskErrors[task.name];
    if (!(task.name in this.taskResults)) throw new Error(`No fake result for task ${task.name}`);
    return this.taskResults[task.name] as TOutput;
  }
}

export class FakeSlack implements SlackClient {
  alerts: IdentityAlert[] = [];
  drafts: DiscoveryDraft[] = [];
  updates: DiscoveryDraft[] = [];
  texts: string[] = [];
  fail = false;

  async sendIdentityAlert(alert: IdentityAlert): Promise<void> {
    if (this.fail) throw new Error('Slack unavailable');
    this.alerts.push(alert);
  }

  async sendDraft(draft: DiscoveryDraft): Promise<void> {
    this.drafts.push(draft);
  }

  async updateDraft(_channelId: string, _messageTs: string, draft: DiscoveryDraft): Promise<void> {
    this.updates.push(draft);
  }

  async sendChannelText(_channelId: string, text: string): Promise<void> {
    this.texts.push(text);
  }
}

export interface FakeApp extends App {
  anchor: FakeAnchor;
  slack: FakeSlack;
  drafts: MemoryDraftStore;
  state: MemoryStateStore;
  logs: string[];
}

export function createFakeApp(overrides: Partial<Config> = {}): FakeApp {
  const logs: string[] = [];
  return {
    config: testConfig(overrides),
    anchor: new FakeAnchor(),
    slack: new FakeSlack(),
    thumbnails: { generate: async () => thumbnails },
    drafts: new MemoryDraftStore(),
    state: new MemoryStateStore(),
    log: (message) => logs.push(message),
    logs,
  };
}

export function healthyGauge(app: FakeApp): void {
  app.anchor.identities[gaugeApplication.id] = [{ id: 'identity-gauge', name: 'Gauge account', status: 'active' }];
  app.anchor.taskResults['anchor-identity-monitor-gauge-dom-check'] = true;
}

export function healthySearchConsole(app: FakeApp): void {
  app.anchor.identities[searchConsoleApplication.id] = [
    { id: 'identity-search-console', name: 'Google account', status: 'active' },
  ];
  app.anchor.taskResults['anchor-identity-monitor-search-console-dom-check'] = true;
}

export function readyDraft(overrides: Partial<DiscoveryDraft> = {}): DiscoveryDraft {
  return {
    id: 'draft-1',
    createdAt: '2030-01-01T00:00:00.000Z',
    application: gaugeApplication,
    identityId: 'identity-gauge',
    article,
    thumbnails,
    status: 'ready',
    ...overrides,
  };
}
