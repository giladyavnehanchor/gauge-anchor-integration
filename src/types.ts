export type TargetKey = 'gauge' | 'search-console';
export type ThumbnailProvider = 'openai' | 'gemini' | 'anthropic';
export type PublishDestination = 'blogs' | 'templates hubs' | 'guides';

export type IdentityStatus =
  | 'active'
  | 'pending'
  | 'validated'
  | 'agent_invalid'
  | 'agent_failed'
  | 'failed';

export type MonitorCondition = 'healthy' | 'missing' | 'stale' | 'pending';

export interface TargetConfig {
  key: TargetKey;
  label: string;
  applicationId?: string;
  applicationName: string;
  applicationUrl?: string;
  identityId?: string;
  validationTaskName?: string;
}

export interface MonitorConfig {
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
  dryRun: boolean;
  requestTimeoutMs: number;
  reauthTimeoutMs: number;
  taskPollIntervalMs: number;
  contentTaskTimeoutMs: number;
  thumbnailTimeoutMs?: number;
  gaugeContentTaskName: string;
  gaugePublishTaskName: string;
  searchConsoleIndexTaskName: string;
  thumbnailProvider?: ThumbnailProvider;
  thumbnailModel?: string;
  thumbnailOutputDir?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  anthropicApiKey?: string;
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
  latestVersion?: string;
  aiFallbackEnabled?: boolean;
  generationStatus?: string;
}

export interface AnchorSessionUpload {
  fileName: string;
}

export interface AnchorFile {
  fileName: string;
  mimeType: string;
  data: Uint8Array;
}

export interface GaugeContentTaskResult {
  ticketUrl: string;
  articleTitle: string;
  articleSummary: string;
  researchCompleted: boolean;
  outlineCompleted: boolean;
  published: boolean;
  message: string;
}

export interface ThumbnailOption {
  title: string;
  prompt: string;
  imageUrl?: string;
  filePath?: string;
  mimeType?: string;
}

export interface IdentityLink {
  url: string;
  expiresAt: string;
}

export interface ReauthenticationResult {
  identityId: string;
  async?: boolean;
}

export interface StateEntry {
  condition: MonitorCondition;
  applicationId: string;
  identityId?: string;
  lastNotifiedCondition?: MonitorCondition;
  updatedAt: string;
}

export type MonitorState = Record<string, StateEntry>;

export interface StateStore {
  get(key: string): Promise<StateEntry | undefined>;
  put(key: string, entry: StateEntry): Promise<void>;
}

export interface AnchorClient {
  listApplications(search?: string): Promise<AnchorApplication[]>;
  createApplication(source: string, name: string): Promise<AnchorApplication>;
  listIdentities(applicationId: string): Promise<AnchorIdentity[]>;
  createIdentityLink(applicationId: string, userName?: string): Promise<IdentityLink>;
  validateIdentity(
    identityId: string,
    source: string,
    applicationId: string,
    taskName: string,
  ): Promise<boolean>;
  runGaugeContentTask(
    applicationId: string,
    identityId: string,
    taskName: string,
  ): Promise<GaugeContentTaskResult | null>;
  publishGaugeArticle(
    applicationId: string,
    identityId: string,
    taskName: string,
    input: PublishRequest,
    thumbnail: AnchorFile,
  ): Promise<string>;
  requestSearchConsoleIndexing(
    applicationId: string,
    identityId: string,
    taskName: string,
    articleUrl: string,
  ): Promise<{ requested: boolean; message: string }>;
  reauthenticate(identityId: string): Promise<ReauthenticationResult>;
  createReauthLink(identityId: string, authMethod: MonitorConfig['reauthAuthMethod']): Promise<IdentityLink>;
}

export interface SlackMessage {
  target: TargetConfig;
  condition: MonitorCondition | 'recovered';
  application: AnchorApplication;
  identity?: AnchorIdentity;
  link?: IdentityLink;
}

export interface SlackClient {
  send(message: SlackMessage): Promise<void>;
  sendGaugeContent?(message: GaugeContentMessage): Promise<void>;
}

export interface GaugeContentMessage {
  target: TargetConfig;
  application: AnchorApplication;
  result: GaugeContentTaskResult;
  thumbnails: ThumbnailOption[];
  draftId?: string;
  selectedThumbnailIndex?: number;
  destination?: PublishDestination;
}

export interface ThumbnailClient {
  generate(articleTitle: string, articleSummary: string): Promise<ThumbnailOption[]>;
}

export interface MonitorDependencies {
  anchor: AnchorClient;
  slack: SlackClient;
  state: StateStore;
  now?: () => Date;
  log?: (message: string, details?: Record<string, unknown>) => void;
}

export interface TargetResult {
  target: TargetKey;
  condition: MonitorCondition;
  application: AnchorApplication;
  applicationId: string;
  identityId?: string;
  notified: boolean;
}

export interface GaugeContentRun {
  result: GaugeContentTaskResult;
  thumbnails: ThumbnailOption[];
}

export interface DiscoveryDraft {
  id: string;
  createdAt: string;
  application: AnchorApplication;
  content: GaugeContentTaskResult;
  applicationId: string;
  identityId: string;
  searchConsoleApplicationId: string;
  searchConsoleIdentityId: string;
  ticketUrl: string;
  articleTitle: string;
  articleSummary: string;
  thumbnails: ThumbnailOption[];
  status?: 'ready' | 'published';
  selectedThumbnailIndex?: number;
  selectedDestination?: PublishDestination;
  publishedArticleUrl?: string;
  indexingRequested?: boolean;
  indexingMessage?: string;
}

export interface PublishRequest {
  draftId?: string;
  ticketUrl: string;
  articleTitle: string;
  articleSummary: string;
  thumbnailPath: string;
  destination: PublishDestination;
}

export interface PublishResult {
  articleUrl: string;
  indexingRequested: boolean;
  indexingMessage: string;
}

export interface MonitorRunResult {
  startedAt: string;
  completedAt: string;
  targets: TargetResult[];
}
