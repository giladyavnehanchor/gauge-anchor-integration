import { isStaleValidationError } from './anchor.js';
import type { App } from './app.js';
import { authCheck } from './tasks.js';
import type {
  AnchorApplication,
  AnchorIdentity,
  Identity,
  IdentityCheck,
  IdentityCondition,
  IdentityLink,
  TargetConfig,
  TargetKey,
} from './types.js';

export async function ensureIdentity(app: App, key: TargetKey): Promise<Identity | undefined> {
  const check = await checkIdentity(app, key);
  if (check.condition === 'healthy' && check.identityId) {
    return { key, application: check.application, identityId: check.identityId };
  }
  app.log(`${targetFor(app, key).label} identity is not usable`, { condition: check.condition });
  return undefined;
}

export async function requireIdentity(app: App, key: TargetKey): Promise<Identity> {
  const identity = await ensureIdentity(app, key);
  if (!identity) {
    throw new Error(`${targetFor(app, key).label} identity is missing or needs re-authentication in Anchor`);
  }
  return identity;
}

export async function checkIdentity(app: App, key: TargetKey, validate = true): Promise<IdentityCheck> {
  const target = targetFor(app, key);
  const application = await findApplication(app, target);
  const identity = chooseIdentity(target, await app.anchor.listIdentities(application.id));
  const condition = await resolveCondition(app, target, application, identity, validate);
  const notified = await notifyIfChanged(app, target, application, identity, condition);
  app.log(`${target.label} identity checked`, { condition, notified });
  return {
    key,
    condition,
    application,
    ...(identity ? { identityId: identity.id } : {}),
    notified,
  };
}

function targetFor(app: App, key: TargetKey): TargetConfig {
  const target = app.config.targets.find((candidate) => candidate.key === key);
  if (!target) throw new Error(`Target ${key} is not configured`);
  return target;
}

function normalizedUrl(value: string): string {
  const parsed = new URL(/^[a-z][a-z\d+\-.]*:\/\//i.test(value) ? value : `https://${value}`);
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/+$/, '').toLocaleLowerCase();
}

function sameApplication(target: TargetConfig, application: AnchorApplication): boolean {
  if (!application.url) return false;
  try {
    return normalizedUrl(application.url) === normalizedUrl(target.applicationUrl);
  } catch {
    return false;
  }
}

async function findApplication(app: App, target: TargetConfig): Promise<AnchorApplication> {
  if (target.applicationId) {
    const application = (await app.anchor.listApplications()).find(({ id }) => id === target.applicationId);
    if (!application) throw new Error(`${target.label} application ${target.applicationId} was not found`);
    return application;
  }

  const candidates = new Map<string, AnchorApplication>();
  for (const search of [target.applicationName, target.applicationUrl]) {
    for (const application of await app.anchor.listApplications(search)) {
      candidates.set(application.id, application);
    }
  }
  const matches = [...candidates.values()].filter((application) => sameApplication(target, application));
  if (matches.length === 1) return matches[0] as AnchorApplication;
  if (matches.length === 0) {
    return app.anchor.createApplication(target.applicationUrl, target.applicationName);
  }
  throw new Error(`${target.label} application match is ambiguous: ${matches.map(({ id }) => id).join(', ')}`);
}

function chooseIdentity(target: TargetConfig, identities: AnchorIdentity[]): AnchorIdentity | undefined {
  if (target.identityId) {
    const identity = identities.find(({ id }) => id === target.identityId);
    if (!identity) throw new Error(`${target.label} identity ${target.identityId} was not found`);
    return identity;
  }
  if (identities.length > 1) {
    const envKey = target.key === 'gauge' ? 'GAUGE_IDENTITY_ID' : 'SEARCH_CONSOLE_IDENTITY_ID';
    throw new Error(`${target.label} has multiple identities; set ${envKey}`);
  }
  return identities[0];
}

async function resolveCondition(
  app: App,
  target: TargetConfig,
  application: AnchorApplication,
  identity: AnchorIdentity | undefined,
  validate: boolean,
): Promise<IdentityCondition> {
  if (!identity) return 'missing';
  if (identity.status === 'pending') return 'pending';
  if (identity.status === 'agent_invalid' || identity.status === 'agent_failed' || identity.status === 'failed') {
    return 'stale';
  }
  if (!validate) return 'healthy';

  try {
    const authenticated = await app.anchor.runTask(authCheck(target), {
      applicationId: application.id,
      identityId: identity.id,
    });
    return authenticated ? 'healthy' : 'stale';
  } catch (error) {
    if (isStaleValidationError(error)) return 'stale';
    throw error;
  }
}

async function notifyIfChanged(
  app: App,
  target: TargetConfig,
  application: AnchorApplication,
  identity: AnchorIdentity | undefined,
  condition: IdentityCondition,
): Promise<boolean> {
  const stateKey = `${target.key}:${application.id}`;
  const previous = await app.state.get(stateKey);
  const broken = condition === 'missing' || condition === 'stale';
  const previouslyBroken = previous?.lastNotifiedCondition === 'missing' || previous?.lastNotifiedCondition === 'stale';
  const alertNeeded = broken && previous?.lastNotifiedCondition !== condition;
  const recoveryNeeded = condition === 'healthy' && app.config.notifyRecovery && previouslyBroken;

  if (alertNeeded || recoveryNeeded) {
    const link = alertNeeded ? await authLink(app, application, identity) : undefined;
    await app.slack.sendIdentityAlert({
      target,
      condition: recoveryNeeded ? 'recovered' : condition,
      application,
      ...(identity ? { identity } : {}),
      ...(link ? { link } : {}),
    });
  }

  const notified = alertNeeded || recoveryNeeded;
  const lastNotifiedCondition = notified ? condition : previous?.lastNotifiedCondition;
  await app.state.put(stateKey, {
    condition,
    applicationId: application.id,
    updatedAt: new Date().toISOString(),
    ...(identity ? { identityId: identity.id } : {}),
    ...(lastNotifiedCondition ? { lastNotifiedCondition } : {}),
  });
  return notified;
}

function authLink(app: App, application: AnchorApplication, identity: AnchorIdentity | undefined): Promise<IdentityLink> {
  return identity
    ? app.anchor.createReauthLink(identity.id, app.config.reauthAuthMethod)
    : app.anchor.createIdentityLink(application.id, app.config.identityUserName);
}
