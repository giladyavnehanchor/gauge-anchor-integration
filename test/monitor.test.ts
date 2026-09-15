import { describe, expect, it } from 'vitest';
import { AnchorApiError } from '../src/anchor.js';
import { MemoryStateStore } from '../src/state.js';
import { runIdentityMonitor } from '../src/monitor.js';
import type {
  AnchorApplication,
  AnchorClient,
  AnchorIdentity,
  GaugeContentTaskResult,
  IdentityLink,
  MonitorConfig,
  SlackClient,
  SlackMessage,
} from '../src/types.js';

const application: AnchorApplication = {
  id: 'app-gauge',
  name: 'Gauge',
  url: 'https://gauge.example.com',
};

const target = {
  key: 'gauge' as const,
  label: 'Gauge',
  applicationName: 'Gauge',
  applicationUrl: 'https://gauge.example.com',
};

function config(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    anchorApiBase: 'https://api.anchorbrowser.io/v1',
    anchorApiKey: 'test-key',
    slackWebhookUrl: 'https://hooks.slack.test/webhook',
    reauthAuthMethod: 'profile',
    notifyRecovery: true,
    dryRun: false,
    requestTimeoutMs: 1000,
    reauthTimeoutMs: 1000,
    taskPollIntervalMs: 1,
    contentTaskTimeoutMs: 1000,
    gaugeContentTaskName: 'gauge-content-research-outline',
    gaugePublishTaskName: 'gauge-publish-article-from-todo',
    searchConsoleIndexTaskName: 'search-console-request-indexing',
    port: 8787,
    targets: [target],
    ...overrides,
  };
}

class FakeAnchor implements AnchorClient {
  identities: AnchorIdentity[] = [];
  applications: AnchorApplication[] = [application];
  reauthError?: unknown;
  validationError?: unknown;
  identityLinks = 0;
  reauthLinks = 0;
  reauthentications = 0;
  validations = 0;
  validationResult = true;
  createdApplications = 0;

  async listApplications(): Promise<AnchorApplication[]> {
    return this.applications;
  }

  async createApplication(): Promise<AnchorApplication> {
    this.createdApplications += 1;
    this.applications = [application];
    return application;
  }

  async listIdentities(): Promise<AnchorIdentity[]> {
    return this.identities;
  }

  async createIdentityLink(): Promise<IdentityLink> {
    this.identityLinks += 1;
    return { url: 'https://anchor.test/create', expiresAt: '2030-01-01T00:00:00Z' };
  }

  async validateIdentity(
    _identityId: string,
    _source: string,
    _applicationId: string,
    _taskName: string,
  ): Promise<boolean> {
    this.validations += 1;
    if (this.validationError) throw this.validationError;
    return this.validationResult;
  }

  async runGaugeContentTask(): Promise<GaugeContentTaskResult> {
    return {
      ticketUrl: 'https://app.withgauge.com/tasks/ticket-1',
      articleTitle: 'Gauge article',
      articleSummary: 'Gauge article summary',
      researchCompleted: true,
      outlineCompleted: true,
      published: false,
      message: 'Ready',
    };
  }

  async publishGaugeArticle(): Promise<string> {
    throw new Error('not used in monitor tests');
  }

  async requestSearchConsoleIndexing(): Promise<{ requested: boolean; message: string }> {
    throw new Error('not used in monitor tests');
  }

  async reauthenticate(identityId: string) {
    this.reauthentications += 1;
    if (this.reauthError) throw this.reauthError;
    return { identityId, async: false };
  }

  async createReauthLink(): Promise<IdentityLink> {
    this.reauthLinks += 1;
    return { url: 'https://anchor.test/reauth', expiresAt: '2030-01-01T00:00:00Z' };
  }
}

class FakeSlack implements SlackClient {
  messages: SlackMessage[] = [];
  fail = false;

  async send(message: SlackMessage): Promise<void> {
    if (this.fail) throw new Error('Slack unavailable');
    this.messages.push(message);
  }

}

describe('runIdentityMonitor', () => {
  it('notifies once when an identity is missing', async () => {
    const anchor = new FakeAnchor();
    const slack = new FakeSlack();
    const state = new MemoryStateStore();

    await runIdentityMonitor(config(), { anchor, slack, state });
    await runIdentityMonitor(config(), { anchor, slack, state });

    expect(anchor.identityLinks).toBe(1);
    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0]?.condition).toBe('missing');
  });

  it('recreates a deleted application before generating an identity link', async () => {
    const anchor = new FakeAnchor();
    anchor.applications = [];
    const slack = new FakeSlack();

    await runIdentityMonitor(config(), {
      anchor,
      slack,
      state: new MemoryStateStore(),
    });

    expect(anchor.createdApplications).toBe(1);
    expect(anchor.identityLinks).toBe(1);
    expect(slack.messages[0]?.link?.url).toBe('https://anchor.test/create');
  });

  it('validates an active identity and creates a reauth link when stale', async () => {
    const anchor = new FakeAnchor();
    anchor.identities = [{ id: 'identity-1', name: 'Gauge account', status: 'active' }];
    anchor.validationError = new AnchorApiError(
      'Profile is not authenticated',
      500,
      'POST',
      '/task/run/auth.validate-profile-authenticated',
    );
    const slack = new FakeSlack();

    const result = await runIdentityMonitor(config(), {
      anchor,
      slack,
      state: new MemoryStateStore(),
    });

    expect(result.targets[0]?.condition).toBe('stale');
    expect(anchor.validations).toBe(1);
    expect(anchor.reauthLinks).toBe(1);
    expect(slack.messages[0]?.link?.url).toBe('https://anchor.test/reauth');
  });

  it('treats a false profile-authentication task result as stale', async () => {
    const anchor = new FakeAnchor();
    anchor.identities = [{ id: 'identity-1', name: 'Gauge account', status: 'active' }];
    anchor.validationResult = false;
    const slack = new FakeSlack();

    const result = await runIdentityMonitor(config(), {
      anchor,
      slack,
      state: new MemoryStateStore(),
    });

    expect(result.targets[0]?.condition).toBe('stale');
    expect(anchor.reauthLinks).toBe(1);
  });

  it('sends a recovery message after a stale-to-healthy transition', async () => {
    const anchor = new FakeAnchor();
    anchor.identities = [{ id: 'identity-1', name: 'Gauge account', status: 'agent_invalid' }];
    const slack = new FakeSlack();
    const state = new MemoryStateStore();
    await runIdentityMonitor(config(), { anchor, slack, state });

    anchor.identities = [{ id: 'identity-1', name: 'Gauge account', status: 'active' }];
    await runIdentityMonitor(config(), { anchor, slack, state });

    expect(slack.messages).toHaveLength(2);
    expect(slack.messages[1]?.condition).toBe('recovered');
  });

  it('does not overwrite state when Slack delivery fails', async () => {
    const anchor = new FakeAnchor();
    const slack = new FakeSlack();
    const state = new MemoryStateStore();
    slack.fail = true;

    await expect(runIdentityMonitor(config(), { anchor, slack, state })).rejects.toThrow(
      'Slack unavailable',
    );
    slack.fail = false;
    await runIdentityMonitor(config(), { anchor, slack, state });

    expect(slack.messages).toHaveLength(1);
  });

  it('fails on ambiguous applications', async () => {
    const anchor = new FakeAnchor();
    anchor.applications = [
      application,
      { ...application, id: 'app-gauge-2' },
    ];

    await expect(
      runIdentityMonitor(config(), {
        anchor,
        slack: new FakeSlack(),
        state: new MemoryStateStore(),
      }),
    ).rejects.toThrow('application match is ambiguous');
  });

  it('matches Anchor URLs that omit the scheme', async () => {
    const anchor = new FakeAnchor();
    anchor.applications = [{ ...application, url: 'gauge.example.com' }];

    const result = await runIdentityMonitor(config(), {
      anchor,
      slack: new FakeSlack(),
      state: new MemoryStateStore(),
    });

    expect(result.targets[0]?.applicationId).toBe('app-gauge');
  });

});
