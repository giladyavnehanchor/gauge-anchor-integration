import { isStaleValidationError } from './anchor.js';
import type {
  AnchorApplication,
  AnchorIdentity,
  MonitorConfig,
  MonitorDependencies,
  MonitorRunResult,
  MonitorCondition,
  IdentityLink,
  StateEntry,
  TargetConfig,
  TargetKey,
  TargetResult,
} from './types.js';

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizedUrl(value: string): string {
  const candidate = /^[a-z][a-z\d+\-.]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  const parsed = new URL(candidate);
  parsed.hash = '';
  parsed.search = '';
  parsed.hostname = parsed.hostname.toLocaleLowerCase();
  if ((parsed.protocol === 'https:' && parsed.port === '443') ||
      (parsed.protocol === 'http:' && parsed.port === '80')) {
    parsed.port = '';
  }
  return parsed.toString().replace(/\/+$/, '');
}

function applicationMatches(target: TargetConfig, application: AnchorApplication): boolean {
  if (target.applicationUrl) {
    if (!application.url) return false;
    try {
      return normalizedUrl(application.url) === normalizedUrl(target.applicationUrl);
    } catch {
      return false;
    }
  }
  return normalizedName(application.name) === normalizedName(target.applicationName);
}

async function findApplication(
  target: TargetConfig,
  dependencies: MonitorDependencies,
): Promise<AnchorApplication> {
  const candidates = new Map<string, AnchorApplication>();
  const searches = target.applicationUrl
    ? [target.applicationName, target.applicationUrl]
    : [target.applicationName];

  if (target.applicationId) {
    for (const application of await dependencies.anchor.listApplications()) {
      if (application.id === target.applicationId) return application;
    }
    throw new Error(`${target.label} application ${target.applicationId} was not found`);
  }

  for (const search of searches) {
    for (const application of await dependencies.anchor.listApplications(search)) {
      candidates.set(application.id, application);
    }
  }

  const matches = [...candidates.values()].filter((application) =>
    applicationMatches(target, application),
  );
  if (matches.length === 1) return matches[0] as AnchorApplication;
  if (matches.length === 0) {
    if (target.applicationUrl) {
      return dependencies.anchor.createApplication(
        target.applicationUrl,
        target.applicationName,
      );
    }
    throw new Error(`${target.label} application was not found by name ${target.applicationName}`);
  }
  throw new Error(
    `${target.label} application match is ambiguous: ${matches.map((application) => application.id).join(', ')}`,
  );
}

function chooseIdentity(
  target: TargetConfig,
  identities: AnchorIdentity[],
): AnchorIdentity | undefined {
  if (target.identityId) {
    const identity = identities.find((candidate) => candidate.id === target.identityId);
    if (!identity) {
      throw new Error(`${target.label} identity ${target.identityId} was not found`);
    }
    return identity;
  }
  if (identities.length > 1) {
    throw new Error(
      `${target.label} has multiple identities; set ${target.key === 'gauge' ? 'GAUGE' : 'SEARCH_CONSOLE'}_IDENTITY_ID`,
    );
  }
  return identities[0];
}

function conditionFromStatus(status: AnchorIdentity['status']): MonitorCondition {
  if (status === 'pending') return 'pending';
  if (status === 'agent_invalid' || status === 'agent_failed' || status === 'failed') {
    return 'stale';
  }
  return 'healthy';
}

async function evaluateTarget(
  target: TargetConfig,
  config: MonitorConfig,
  dependencies: MonitorDependencies,
  validateIdentity: boolean,
): Promise<TargetResult> {
  const application = await findApplication(target, dependencies);
  const identities = await dependencies.anchor.listIdentities(application.id);
  const identity = chooseIdentity(target, identities);
  let condition: MonitorCondition;

  if (!identity) {
    condition = 'missing';
  } else {
    condition = conditionFromStatus(identity.status);
    if (condition === 'healthy' && validateIdentity && !config.dryRun) {
      try {
        const source = application.url ?? target.applicationUrl;
        if (!source) throw new Error(`${target.label} application has no source URL`);
        const taskName =
          target.validationTaskName ??
          `anchor-identity-monitor-${target.key}-dom-check`;
        const authenticated = await dependencies.anchor.validateIdentity(
          identity.id,
          source,
          application.id,
          taskName,
        );
        if (!authenticated) condition = 'stale';
      } catch (error) {
        if (!isStaleValidationError(error)) throw error;
        condition = 'stale';
      }
    }
  }

  if (config.dryRun) {
    return {
      target: target.key,
      condition,
      application,
      applicationId: application.id,
      ...(identity ? { identityId: identity.id } : {}),
      notified: false,
    };
  }

  const stateKey = `${target.key}:${application.id}`;
  const previous = await dependencies.state.get(stateKey);
  const shouldNotify =
    (condition === 'missing' || condition === 'stale') &&
    previous?.lastNotifiedCondition !== condition;
  const shouldNotifyRecovery =
    condition === 'healthy' &&
    config.notifyRecovery &&
    (previous?.lastNotifiedCondition === 'missing' || previous?.lastNotifiedCondition === 'stale');
  let link: IdentityLink | undefined;
  if (shouldNotify) {
    link = identity
      ? await dependencies.anchor.createReauthLink(identity.id, config.reauthAuthMethod)
      : await dependencies.anchor.createIdentityLink(application.id, config.identityUserName);
  }
  let notified = false;

  if (shouldNotify || shouldNotifyRecovery) {
    await dependencies.slack.send({
      target,
      condition: shouldNotifyRecovery ? 'recovered' : condition,
      application,
      ...(identity ? { identity } : {}),
      ...(link ? { link } : {}),
    });
    notified = true;
  }

  const nextState: StateEntry = {
    condition,
    applicationId: application.id,
    updatedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
    ...(identity ? { identityId: identity.id } : {}),
    ...(previous?.lastNotifiedCondition
      ? { lastNotifiedCondition: notified ? condition : previous.lastNotifiedCondition }
      : notified
        ? { lastNotifiedCondition: condition }
        : {}),
  };
  await dependencies.state.put(stateKey, nextState);

  return {
    target: target.key,
    condition,
    application,
    applicationId: application.id,
    ...(identity ? { identityId: identity.id } : {}),
    notified,
  };
}

export interface IdentityMonitorOptions {
  targetKeys?: TargetKey[];
  validateIdentities?: boolean | ((key: TargetKey) => boolean);
}

function shouldValidateIdentity(
  key: TargetKey,
  validateIdentities: IdentityMonitorOptions['validateIdentities'],
): boolean {
  if (typeof validateIdentities === 'function') return validateIdentities(key);
  return validateIdentities !== false;
}

export async function runIdentityMonitor(
  config: MonitorConfig,
  dependencies: MonitorDependencies,
  options: IdentityMonitorOptions = {},
): Promise<MonitorRunResult> {
  const now = dependencies.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const results: TargetResult[] = [];
  const targets = options.targetKeys
    ? config.targets.filter((target) => options.targetKeys?.includes(target.key))
    : config.targets;

  for (const target of targets) {
    const result = await evaluateTarget(
      target,
      config,
      dependencies,
      shouldValidateIdentity(target.key, options.validateIdentities),
    );
    results.push(result);
    dependencies.log?.('Identity monitor target completed', {
      target: result.target,
      condition: result.condition,
      notified: result.notified,
    });
  }

  return {
    startedAt,
    completedAt: now().toISOString(),
    targets: results,
  };
}

export async function ensureSearchConsoleIdentity(
  config: MonitorConfig,
  dependencies: MonitorDependencies,
): Promise<{ applicationId: string; identityId: string }> {
  const result = await runIdentityMonitor(config, dependencies, {
    targetKeys: ['search-console'],
  });
  const searchConsole = result.targets.find(({ target }) => target === 'search-console');
  if (
    !searchConsole ||
    searchConsole.condition !== 'healthy' ||
    !searchConsole.identityId
  ) {
    throw new Error(
      'Google Search Console identity is missing or needs re-authentication',
    );
  }
  return {
    applicationId: searchConsole.applicationId,
    identityId: searchConsole.identityId,
  };
}
