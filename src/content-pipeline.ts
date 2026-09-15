import type {
  AnchorClient,
  GaugeContentRun,
  GaugeContentTaskResult,
  MonitorConfig,
  MonitorDependencies,
  MonitorRunResult,
  SlackClient,
  ThumbnailClient,
} from './types.js';

export async function runGaugeContentWorkflow(
  config: MonitorConfig,
  monitorResult: MonitorRunResult,
  dependencies: {
    anchor: AnchorClient;
    log?: MonitorDependencies['log'];
  },
): Promise<GaugeContentTaskResult | undefined> {
  if (config.dryRun) {
    dependencies.log?.('Gauge content workflow skipped', { reason: 'dry-run' });
    return undefined;
  }

  const gauge = monitorResult.targets.find(({ target }) => target === 'gauge');
  if (!gauge || gauge.condition !== 'healthy' || !gauge.identityId) {
    dependencies.log?.('Gauge content workflow skipped', {
      reason: 'identity gate',
      gaugeCondition: gauge?.condition ?? 'missing',
      gaugeIdentityPresent: Boolean(gauge?.identityId),
    });
    return undefined;
  }

  dependencies.log?.('Gauge content task started', {
    taskName: config.gaugeContentTaskName,
    applicationId: gauge.application.id,
    identityId: gauge.identityId,
  });
  const content = await dependencies.anchor.runGaugeContentTask(
    gauge.application.id,
    gauge.identityId,
    config.gaugeContentTaskName,
  );
  if (!content) {
    dependencies.log?.('Gauge content task returned no article', {
      taskName: config.gaugeContentTaskName,
    });
    return undefined;
  }
  dependencies.log?.('Gauge content task returned article', {
    ticketUrl: content.ticketUrl,
    articleTitle: content.articleTitle,
    researchCompleted: content.researchCompleted,
    outlineCompleted: content.outlineCompleted,
    published: content.published,
  });
  return content;
}

export async function prepareDataForSlack(
  config: MonitorConfig,
  content: GaugeContentTaskResult,
  dependencies: {
    thumbnails: ThumbnailClient;
    log?: MonitorDependencies['log'];
  },
): Promise<GaugeContentRun> {
  if (
    !config.thumbnailProvider ||
    (config.thumbnailProvider === 'openai' && !config.openaiApiKey) ||
    (config.thumbnailProvider === 'gemini' && !config.geminiApiKey) ||
    config.thumbnailProvider === 'anthropic'
  ) {
    throw new Error(
      'Gauge content requires an image-capable thumbnail provider: configure OPENAI_API_KEY or GEMINI_API_KEY',
    );
  }

  dependencies.log?.('Gauge thumbnail generation started', {
    provider: config.thumbnailProvider,
    model: config.thumbnailModel ?? 'provider default',
  });
  const thumbnails = await dependencies.thumbnails.generate(
    content.articleTitle,
    content.articleSummary,
  );
  return { result: content, thumbnails };
}

export async function sendGaugeContentToSlack(
  config: MonitorConfig,
  monitorResult: MonitorRunResult,
  prepared: GaugeContentRun,
  dependencies: {
    slack: SlackClient;
    draftId?: string;
    log?: MonitorDependencies['log'];
  },
): Promise<void> {
  const target = config.targets.find(({ key }) => key === 'gauge');
  if (!target) throw new Error('Gauge target is not configured');
  const gauge = monitorResult.targets.find(({ target: key }) => key === 'gauge');
  if (!gauge) throw new Error('Gauge target result is missing');
  if (!dependencies.slack.sendGaugeContent) {
    throw new Error('Slack client does not support Gauge content notifications');
  }

  dependencies.log?.('Gauge content notification started', {
    thumbnailCount: prepared.thumbnails.length,
    ticketUrl: prepared.result.ticketUrl,
  });
  await dependencies.slack.sendGaugeContent({
    target,
    application: gauge.application,
    result: prepared.result,
    thumbnails: prepared.thumbnails,
    ...(dependencies.draftId ? { draftId: dependencies.draftId } : {}),
  });
  dependencies.log?.('Gauge content task completed', {
    ticketUrl: prepared.result.ticketUrl,
    articleTitle: prepared.result.articleTitle,
    thumbnailCount: prepared.thumbnails.length,
  });
}
