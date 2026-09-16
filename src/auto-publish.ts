import type { App } from './app.js';
import { publish } from './publish.js';
import type { DiscoveryDraft, PublishDestination } from './types.js';

export const AUTO_PUBLISH_DESTINATION: PublishDestination = 'blogs';

/** Starts the countdown after a draft reaches Slack. Any Slack interaction on the draft cancels it. */
export async function scheduleAutoPublish(app: App, draft: DiscoveryDraft): Promise<DiscoveryDraft> {
  const delayMs = app.config.autoPublishDelayMs;
  if (delayMs === 0 || draft.status !== 'ready') return draft;

  const scheduled = { ...draft, autoPublishAt: new Date(Date.now() + delayMs).toISOString() };
  await app.drafts.put(scheduled);
  armTimer(app, scheduled.id, delayMs);
  app.log('Auto-publish scheduled', { draftId: draft.id, autoPublishAt: scheduled.autoPublishAt });
  return scheduled;
}

export async function cancelAutoPublish(app: App, draft: DiscoveryDraft): Promise<DiscoveryDraft> {
  if (!draft.autoPublishAt) return draft;
  const { autoPublishAt: _cancelled, ...cancelled } = draft;
  await app.drafts.put(cancelled);
  app.log('Auto-publish cancelled by a Slack interaction', { draftId: draft.id });
  return cancelled;
}

/** Re-arms countdowns that were pending when the process last stopped. */
export async function resumeAutoPublish(app: App): Promise<number> {
  const pending = (await app.drafts.list()).filter((draft) => draft.autoPublishAt && draft.status === 'ready');
  for (const draft of pending) {
    armTimer(app, draft.id, Math.max(0, Date.parse(draft.autoPublishAt as string) - Date.now()));
  }
  if (pending.length > 0) app.log('Auto-publish countdowns resumed', { count: pending.length });
  return pending.length;
}

function armTimer(app: App, draftId: string, delayMs: number): void {
  setTimeout(() => {
    autoPublish(app, draftId).catch((error) => {
      app.log('Auto-publish failed', { draftId, error: error instanceof Error ? error.message : String(error) });
    });
  }, delayMs);
}

async function autoPublish(app: App, draftId: string): Promise<void> {
  const draft = await app.drafts.get(draftId);
  if (!draft?.autoPublishAt || draft.status !== 'ready') return;

  const thumbnail = draft.thumbnails[0];
  if (!thumbnail?.filePath) {
    await notify(app, `Skipped automatic publishing of "${draft.article.title}": the draft has no thumbnail file.`);
    return;
  }

  const { autoPublishAt: _fired, ...chosen } = draft;
  await app.drafts.put({ ...chosen, selectedThumbnailIndex: 0, selectedDestination: AUTO_PUBLISH_DESTINATION });
  const minutes = Math.round(app.config.autoPublishDelayMs / 60_000);
  await notify(
    app,
    `Nobody reviewed "${draft.article.title}" within ${minutes} minutes, so I am publishing it automatically ` +
      `to ${AUTO_PUBLISH_DESTINATION} with thumbnail 1 (${thumbnail.title}).`,
  );

  try {
    const result = await publish(app, draft.id, { thumbnailPath: thumbnail.filePath, destination: AUTO_PUBLISH_DESTINATION });
    app.log('Auto-publish completed', { draftId: draft.id, articleUrl: result.articleUrl });
    await app.slack.sendPublishResult(draft, result).catch((slackError) => {
      console.error('Slack auto-publish notification failed', slackError);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    app.log('Auto-publish failed', { draftId: draft.id, error: message });
    await notify(app, `Automatic publishing failed for "${draft.article.title}": ${message}`);
  }
}

async function notify(app: App, text: string): Promise<void> {
  app.log(text);
  await app.slack.sendChannelText(text).catch((error) => {
    console.error('Slack auto-publish notification failed', error);
  });
}
