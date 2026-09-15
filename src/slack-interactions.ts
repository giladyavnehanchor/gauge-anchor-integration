import type { App } from './app.js';
import { discover } from './discover.js';
import { publish } from './publish.js';
import type { DiscoveryDraft, PublishDestination } from './types.js';

export interface SlackReply {
  response_type: 'ephemeral';
  text: string;
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value as Record<string, unknown>;
}

export function parseDestination(value: unknown): PublishDestination {
  if (value === 'blogs' || value === 'templates hubs' || value === 'guides') return value;
  throw new Error('destination must be blogs, templates hubs, or guides');
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Interaction {
  actionId: string;
  actionValue: Record<string, unknown>;
  selectedOption?: string;
  blockId: string;
  channelId: string;
  messageTs: string;
  userId: string;
}

function parseInteraction(payload: Record<string, unknown>): Interaction {
  const action = record((Array.isArray(payload.actions) ? payload.actions : [])[0]);
  const selected = action.selected_option ? record(action.selected_option) : undefined;
  return {
    actionId: text(action.action_id),
    actionValue: record(JSON.parse(text(action.value) || '{}')),
    ...(selected ? { selectedOption: text(selected.value) } : {}),
    blockId: text(action.block_id),
    channelId: text(record(payload.channel).id),
    messageTs: payload.message ? text(record(payload.message).ts) : '',
    userId: payload.user ? text(record(payload.user).id) : '',
  };
}

export async function handleSlackInteraction(app: App, payload: Record<string, unknown>): Promise<SlackReply> {
  const interaction = parseInteraction(payload);
  if (!interaction.channelId) throw new Error('Slack interaction lacks channel ID');

  if (interaction.actionId === 'run-discovery') {
    void runDiscoveryInBackground(app, interaction.channelId);
    return { response_type: 'ephemeral', text: 'Discovery started. I will post the result in this channel.' };
  }

  const draft = await loadDraft(app, interaction);
  if (!draft) {
    return { response_type: 'ephemeral', text: 'This draft is no longer available. Use the latest discovery message or run discovery again.' };
  }
  if (!interaction.messageTs) throw new Error('Slack interaction lacks message ID');

  if (interaction.actionId.startsWith('thumbnail-select-')) {
    const index = Number(interaction.actionValue.index);
    if (!Number.isInteger(index) || index < 0 || index >= draft.thumbnails.length) {
      throw new Error('Invalid thumbnail selection');
    }
    await updateDraft(app, interaction, { ...draft, selectedThumbnailIndex: index });
    return { response_type: 'ephemeral', text: `Selected thumbnail ${index + 1}.` };
  }

  if (interaction.actionId === 'destination-select') {
    const destination = parseDestination(interaction.selectedOption);
    await updateDraft(app, interaction, { ...draft, selectedDestination: destination });
    return { response_type: 'ephemeral', text: `Selected destination: ${destination}.` };
  }

  if (interaction.actionId === 'publish-article') {
    const thumbnail = draft.selectedThumbnailIndex === undefined
      ? undefined
      : draft.thumbnails[draft.selectedThumbnailIndex];
    if (!thumbnail?.filePath || !draft.selectedDestination) {
      return { response_type: 'ephemeral', text: 'Choose a thumbnail and destination before posting.' };
    }
    void publishInBackground(app, interaction.channelId, draft, thumbnail.filePath, draft.selectedDestination);
    return { response_type: 'ephemeral', text: `Publishing started for <@${interaction.userId}>.` };
  }

  throw new Error(`Unsupported Slack action: ${interaction.actionId}`);
}

async function loadDraft(app: App, interaction: Interaction): Promise<DiscoveryDraft | undefined> {
  const prefix = 'destination-selection:';
  const draftId = text(interaction.actionValue.draftId) ||
    (interaction.blockId.startsWith(prefix) ? interaction.blockId.slice(prefix.length) : '');
  const draft = draftId ? await app.drafts.get(draftId) : undefined;
  if (!draft) app.log('Slack interaction for unknown draft', { draftId, actionId: interaction.actionId });
  return draft;
}

async function updateDraft(app: App, interaction: Interaction, draft: DiscoveryDraft): Promise<void> {
  await app.drafts.put(draft);
  await app.slack.updateDraft(interaction.channelId, interaction.messageTs, draft);
}

async function runDiscoveryInBackground(app: App, channelId: string): Promise<void> {
  try {
    const draft = await discover(app);
    await app.slack.sendChannelText(
      channelId,
      draft ? `Discovery finished. Draft created for "${draft.article.title}".` : 'Discovery finished. No draft was created.',
    );
  } catch (error) {
    await notifyFailure(app, channelId, `Discovery failed: ${errorText(error)}`);
  }
}

async function publishInBackground(
  app: App,
  channelId: string,
  draft: DiscoveryDraft,
  thumbnailPath: string,
  destination: PublishDestination,
): Promise<void> {
  try {
    const result = await publish(app, draft.id, { thumbnailPath, destination });
    await app.slack.sendChannelText(
      channelId,
      `Published <${result.articleUrl}|${draft.article.title}>. Search indexing: ${result.indexingMessage}`,
    );
  } catch (error) {
    await notifyFailure(app, channelId, `Publishing failed for ${draft.article.title}: ${errorText(error)}`);
  }
}

async function notifyFailure(app: App, channelId: string, message: string): Promise<void> {
  app.log(message);
  await app.slack.sendChannelText(channelId, message).catch((error) => {
    console.error('Slack failure notification failed', error);
  });
}
