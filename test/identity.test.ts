import { describe, expect, it } from 'vitest';
import { AnchorApiError } from '../src/anchor.js';
import { checkIdentity, ensureIdentity, requireIdentity } from '../src/identity.js';
import { createFakeApp, gaugeApplication, healthyGauge } from './fakes.js';

describe('checkIdentity', () => {
  it('notifies once when an identity is missing', async () => {
    const app = createFakeApp();

    await checkIdentity(app, 'gauge');
    await checkIdentity(app, 'gauge');

    expect(app.anchor.identityLinks).toBe(1);
    expect(app.slack.alerts).toHaveLength(1);
    expect(app.slack.alerts[0]?.condition).toBe('missing');
  });

  it('recreates a deleted application before generating an identity link', async () => {
    const app = createFakeApp();
    app.anchor.applications = [];

    const check = await checkIdentity(app, 'gauge');

    expect(app.anchor.createdApplications).toBe(1);
    expect(check.application.url).toBe('https://app.withgauge.com');
    expect(app.slack.alerts[0]?.link?.url).toBe('https://anchor.test/create');
  });

  it('runs the DOM auth check and creates a reauth link when it fails', async () => {
    const app = createFakeApp();
    healthyGauge(app);
    app.anchor.taskErrors['anchor-identity-monitor-gauge-dom-check'] = new AnchorApiError(
      'Profile is not authenticated',
      500,
      'POST',
      '/v2/tasks/run',
    );

    const check = await checkIdentity(app, 'gauge');

    expect(check.condition).toBe('stale');
    expect(app.anchor.taskRuns.map(({ task }) => task)).toEqual(['anchor-identity-monitor-gauge-dom-check']);
    expect(app.anchor.reauthLinks).toBe(1);
    expect(app.slack.alerts[0]?.link?.url).toBe('https://anchor.test/reauth');
  });

  it('treats authenticated=false as stale', async () => {
    const app = createFakeApp();
    healthyGauge(app);
    app.anchor.taskResults['anchor-identity-monitor-gauge-dom-check'] = false;

    expect((await checkIdentity(app, 'gauge')).condition).toBe('stale');
  });

  it('skips the DOM check when validation is disabled', async () => {
    const app = createFakeApp();
    healthyGauge(app);
    delete app.anchor.taskResults['anchor-identity-monitor-gauge-dom-check'];

    expect((await checkIdentity(app, 'gauge', false)).condition).toBe('healthy');
    expect(app.anchor.taskRuns).toHaveLength(0);
  });

  it('sends a recovery message after a stale-to-healthy transition', async () => {
    const app = createFakeApp();
    app.anchor.identities[gaugeApplication.id] = [{ id: 'identity-gauge', name: 'Gauge account', status: 'agent_invalid' }];
    await checkIdentity(app, 'gauge');

    healthyGauge(app);
    await checkIdentity(app, 'gauge');

    expect(app.slack.alerts.map(({ condition }) => condition)).toEqual(['stale', 'recovered']);
  });

  it('does not record a notification when Slack delivery fails', async () => {
    const app = createFakeApp();
    app.slack.fail = true;

    await expect(checkIdentity(app, 'gauge')).rejects.toThrow('Slack unavailable');
    app.slack.fail = false;
    await checkIdentity(app, 'gauge');

    expect(app.slack.alerts).toHaveLength(1);
  });

  it('fails on ambiguous applications', async () => {
    const app = createFakeApp();
    app.anchor.applications = [gaugeApplication, { ...gaugeApplication, id: 'app-gauge-2' }];

    await expect(checkIdentity(app, 'gauge')).rejects.toThrow('application match is ambiguous');
  });

  it('matches Anchor URLs that omit the scheme', async () => {
    const app = createFakeApp();
    app.anchor.applications = [{ ...gaugeApplication, url: 'app.withgauge.com' }];

    expect((await checkIdentity(app, 'gauge')).application.id).toBe('app-gauge');
  });
});

describe('ensureIdentity', () => {
  it('returns the identity when healthy', async () => {
    const app = createFakeApp();
    healthyGauge(app);

    await expect(ensureIdentity(app, 'gauge')).resolves.toEqual({
      key: 'gauge',
      application: gaugeApplication,
      identityId: 'identity-gauge',
    });
  });

  it('returns undefined when the identity is missing and requireIdentity throws', async () => {
    const app = createFakeApp();

    await expect(ensureIdentity(app, 'gauge')).resolves.toBeUndefined();
    await expect(requireIdentity(app, 'search-console')).rejects.toThrow('Google Search Console identity is missing');
  });
});
