export type TargetKey = 'gauge' | 'search-console';
export type ThumbnailProvider = 'openai' | 'gemini';
export type PublishDestination = 'blogs' | 'templates hubs' | 'guides';

export type IdentityStatus =
  | 'active'
  | 'pending'
  | 'validated'
  | 'agent_invalid'
  | 'agent_failed'
  | 'failed';

export type IdentityCondition = 'healthy' | 'missing' | 'stale' | 'pending';

export interface TargetConfig {
  key: TargetKey;
  label: string;
  applicationName: string;
  applicationUrl: string;
  applicationId?: string;
  identityId?: string;
}

export interface Config {
  anchorApiBase: string;
  anchorApiKey: string;
  slackWebhookUrl?: string;
  slackBotToken?: string;
  slackChannelId?: string;
  slackSigningSecret?: string;
  internalApiToken?: string;
  port: number;
  identityUserName?: string;
  reauthAuthMethod: 'profile' | 'dynauth' | 'credentials';
  notifyRecovery: boolean;
  requestTimeoutMs: number;
  taskTimeoutMs: number;
  longTaskTimeoutMs: number;
  taskPollIntervalMs: number;
  thumbnailProvider?: ThumbnailProvider;
  thumbnailModel?: string;
  thumbnailTimeoutMs: number;
  thumbnailOutputDir: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  stateFile: string;
  draftFile: string;
  publishAuthor: string;
  targets: TargetConfig[];
}

export interface AnchorApplication {
  id: string;
  name: string;
  url: string | null;
  identityCount?: number;
}

export interface AnchorIdentity {
  id: string;
  name: string;
  status: IdentityStatus;
  updatedAt?: string;
}

export interface AnchorTask {
  id: string;
  name: string;
  description?: string;
  latestVersion?: string;
  aiFallbackEnabled?: boolean;
  generationStatus?: string;
}

export interface AnchorFile {
  fileName: string;
  mimeType: string;
  data: Uint8Array;
}

export interface IdentityLink {
  url: string;
  expiresAt: string;
}

export interface SchemaField {
  name: string;
  type: 'string' | 'boolean' | 'file';
  description: string;
  required?: boolean;
}

export interface TaskDefinition<TOutput> {
  name: string;
  description: string;
  prompt: string;
  code?: string;
  inputSchema: SchemaField[];
  outputSchema: SchemaField[];
  aiFallback: boolean;
  longRunning?: boolean;
  parse: (output: Record<string, unknown>) => TOutput;
}

export interface RunTaskOptions {
  applicationId: string;
  identityId: string;
  inputs?: Record<string, string>;
  files?: Record<string, AnchorFile>;
}

export interface AnchorClient {
  listApplications(search?: string): Promise<AnchorApplication[]>;
  createApplication(source: string, name: string): Promise<AnchorApplication>;
  listIdentities(applicationId: string): Promise<AnchorIdentity[]>;
  createIdentityLink(applicationId: string, userName?: string): Promise<IdentityLink>;
  createReauthLink(identityId: string, authMethod: Config['reauthAuthMethod']): Promise<IdentityLink>;
  runTask<TOutput>(task: TaskDefinition<TOutput>, options: RunTaskOptions): Promise<TOutput>;
}

export interface Identity {
  key: TargetKey;
  application: AnchorApplication;
  identityId: string;
}

export interface IdentityCheck {
  key: TargetKey;
  condition: IdentityCondition;
  application: AnchorApplication;
  identityId?: string;
  notified: boolean;
}

export interface StateEntry {
  condition: IdentityCondition;
  applicationId: string;
  identityId?: string;
  lastNotifiedCondition?: IdentityCondition;
  updatedAt: string;
}

export interface StateStore {
  get(key: string): Promise<StateEntry | undefined>;
  put(key: string, entry: StateEntry): Promise<void>;
}

export interface Article {
  ticketUrl: string;
  title: string;
  summary: string;
  researchCompleted: boolean;
  outlineCompleted: boolean;
  articleWritten: boolean;
  message: string;
}

export interface ThumbnailOption {
  title: string;
  prompt: string;
  imageUrl?: string;
  filePath?: string;
  mimeType?: string;
}

export interface ThumbnailClient {
  generate(articleTitle: string, articleSummary: string): Promise<ThumbnailOption[]>;
}

export interface DiscoveryDraft {
  id: string;
  createdAt: string;
  application: AnchorApplication;
  identityId: string;
  article: Article;
  thumbnails: ThumbnailOption[];
  status: 'ready' | 'published';
  selectedThumbnailIndex?: number;
  selectedDestination?: PublishDestination;
  publishedArticleUrl?: string;
  indexingRequested?: boolean;
  indexingMessage?: string;
}

export interface DraftStore {
  get(id: string): Promise<DiscoveryDraft | undefined>;
  put(draft: DiscoveryDraft): Promise<void>;
}

export interface PublishChoice {
  thumbnailPath: string;
  destination: PublishDestination;
}

export interface PublishResult {
  articleUrl: string;
  indexingRequested: boolean;
  indexingMessage: string;
}

export interface IdentityAlert {
  target: TargetConfig;
  condition: IdentityCondition | 'recovered';
  application: AnchorApplication;
  identity?: AnchorIdentity;
  link?: IdentityLink;
}

export interface SlackClient {
  sendIdentityAlert(alert: IdentityAlert): Promise<void>;
  sendDraft(draft: DiscoveryDraft): Promise<void>;
  updateDraft(channelId: string, messageTs: string, draft: DiscoveryDraft): Promise<void>;
  sendChannelText(channelId: string, text: string): Promise<void>;
}

export type Log = (message: string, details?: Record<string, unknown>) => void;
