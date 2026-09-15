import type {
  AnchorApplication,
  AnchorClient,
  AnchorFile,
  AnchorIdentity,
  AnchorTask,
  Config,
  IdentityLink,
  RunTaskOptions,
  TaskDefinition,
} from './types.js';

export class AnchorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly method: string,
    readonly path: string,
  ) {
    super(message);
    this.name = 'AnchorApiError';
  }
}

export function isStaleValidationError(error: unknown): boolean {
  if (error instanceof AnchorApiError && (error.status === 412 || error.status === 422)) {
    return true;
  }
  const message = error instanceof Error ? error.message.toLocaleLowerCase() : '';
  return [
    'profile is not authenticated',
    'identity authentication failed',
    'authentication failed',
    'could not be reauthenticated',
    'no credentials',
  ].some((marker) => message.includes(marker));
}

export function workflowCode(task: TaskDefinition<unknown>): string {
  const parameters = (fields: TaskDefinition<unknown>['inputSchema']) =>
    fields.map((field) => ({
      name: field.name,
      type: field.type,
      description: field.description,
      required: field.required ?? true,
      defaultValue: null,
      options: null,
    }));
  return JSON.stringify({
    name: task.name,
    inputParameters: parameters(task.inputSchema),
    outputParameters: parameters(task.outputSchema),
    startSegmentName: 'main',
    segments: [
      {
        name: 'main',
        type: 'ui',
        prompt: task.prompt,
        inputParameters: parameters(task.inputSchema),
        outputParameters: parameters(task.outputSchema),
        deterministic: task.code,
        next: null,
        router: null,
      },
    ],
  });
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Anchor returned an invalid ${context} response`);
  }
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string, context: string): string {
  if (typeof value[key] !== 'string' || !value[key]) {
    throw new Error(`Anchor returned an invalid ${context}.${key}`);
  }
  return value[key] as string;
}

function optionalStringField(value: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof value[key] === 'string') return value[key] as string;
  }
  return undefined;
}

function parseApplication(value: unknown, context: string): AnchorApplication {
  const application = record(value, context);
  const url = application.url;
  if (url !== null && url !== undefined && typeof url !== 'string') {
    throw new Error(`Anchor returned an invalid ${context}.url`);
  }
  return {
    id: stringField(application, 'id', context),
    name: stringField(application, 'name', context),
    url: url ?? null,
    ...(typeof application.identity_count === 'number' ? { identityCount: application.identity_count } : {}),
  };
}

const IDENTITY_STATUSES = ['active', 'pending', 'validated', 'agent_invalid', 'agent_failed', 'failed'];

function parseIdentity(value: unknown, context: string): AnchorIdentity {
  const identity = record(value, context);
  const status = identity.status;
  if (typeof status !== 'string' || !IDENTITY_STATUSES.includes(status)) {
    throw new Error(`Anchor returned an invalid ${context}.status`);
  }
  return {
    id: stringField(identity, 'id', context),
    name: stringField(identity, 'name', context),
    status: status as AnchorIdentity['status'],
    ...(typeof identity.updated_at === 'string' ? { updatedAt: identity.updated_at } : {}),
  };
}

function parseTask(value: unknown, context: string): AnchorTask {
  const task = record(value, context);
  const latestVersion = optionalStringField(task, 'latestVersion', 'latest_version');
  const generationStatus = optionalStringField(task, 'selectedTaskVersion', 'status');
  const aiFallbackEnabled = [task.aiFallbackEnabled, task.ai_fallback_enabled].find(
    (candidate) => typeof candidate === 'boolean',
  ) as boolean | undefined;
  return {
    id: stringField(task, 'id', context),
    name: stringField(task, 'name', context),
    ...(latestVersion ? { latestVersion } : {}),
    ...(generationStatus ? { generationStatus } : {}),
    ...(aiFallbackEnabled !== undefined ? { aiFallbackEnabled } : {}),
  };
}

/**
 * Anchor wraps task output differently depending on how the task was run
 * (`result`, `output`, a JSON string, ...). Walk down until we find an object
 * that contains at least one of the fields the task promised to return.
 */
function unwrapTaskOutput(value: unknown, expectedFields: string[]): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return unwrapTaskOutput(JSON.parse(value) as unknown, expectedFields);
    } catch {
      throw new Error('Anchor task returned invalid JSON output');
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const candidate = value as Record<string, unknown>;
    if (expectedFields.some((field) => field in candidate)) return candidate;
    for (const key of ['result', 'data', 'output', 'outputs', 'value', 'answer']) {
      if (key in candidate) return unwrapTaskOutput(candidate[key], expectedFields);
    }
  }
  throw new Error('Anchor task returned no structured result');
}

/** File inputs travel inside input_params as data URIs; Anchor reads the filename from the URI. */
function fileInputs(files: Record<string, AnchorFile> = {}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(files).flatMap(([field, file]) => {
      const name = encodeURIComponent(file.fileName);
      const base64 = Buffer.from(file.data).toString('base64');
      return [
        [field, `data:${file.mimeType};name=${name};filename=${name};base64,${base64}`],
        [`${field}_original_filename`, file.fileName],
      ];
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ClientConfig = Pick<
  Config,
  'anchorApiBase' | 'anchorApiKey' | 'requestTimeoutMs' | 'taskTimeoutMs' | 'longTaskTimeoutMs' | 'taskPollIntervalMs'
>;

export class HttpAnchorClient implements AnchorClient {
  private readonly v1BaseUrl: string;
  private readonly v2BaseUrl: string;

  constructor(
    private readonly config: ClientConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const base = config.anchorApiBase.replace(/\/+$/, '');
    this.v1BaseUrl = base.endsWith('/v1') ? base : `${base}/v1`;
    this.v2BaseUrl = base.replace(/\/v1$/, '');
  }

  async listApplications(search?: string): Promise<AnchorApplication[]> {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    const body = record(await this.request('GET', `/applications${query}`), 'applications');
    if (!Array.isArray(body.applications)) {
      throw new Error('Anchor returned an invalid applications response');
    }
    return body.applications.map((item, index) => parseApplication(item, `applications[${index}]`));
  }

  async createApplication(source: string, name: string): Promise<AnchorApplication> {
    return parseApplication(await this.request('POST', '/applications', { source, name }), 'application');
  }

  async listIdentities(applicationId: string): Promise<AnchorIdentity[]> {
    const body = record(
      await this.request('GET', `/applications/${encodeURIComponent(applicationId)}/identities`),
      'identities',
    );
    if (!Array.isArray(body.identities)) {
      throw new Error('Anchor returned an invalid identities response');
    }
    return body.identities.map((item, index) => parseIdentity(item, `identities[${index}]`));
  }

  async createIdentityLink(applicationId: string, userName?: string): Promise<IdentityLink> {
    const body = record(
      await this.request(
        'POST',
        `/applications/${encodeURIComponent(applicationId)}/identity-links`,
        userName ? { user_name: userName } : {},
      ),
      'identity link',
    );
    return { url: stringField(body, 'identity_url', 'identity link'), expiresAt: stringField(body, 'expires_at', 'identity link') };
  }

  async createReauthLink(identityId: string, authMethod: Config['reauthAuthMethod']): Promise<IdentityLink> {
    const body = record(
      await this.request('POST', `/identities/${encodeURIComponent(identityId)}/reauth-links`, { authMethod }),
      'reauth link',
    );
    return { url: stringField(body, 'reauth_url', 'reauth link'), expiresAt: stringField(body, 'expires_at', 'reauth link') };
  }

  async runTask<TOutput>(task: TaskDefinition<TOutput>, options: RunTaskOptions): Promise<TOutput> {
    const timeoutMs = task.longRunning ? this.config.longTaskTimeoutMs : this.config.taskTimeoutMs;
    const sessionId = await this.createSession(options.identityId);
    try {
      const taskId = await this.ensureTask(task, options.applicationId, options.identityId, timeoutMs);
      const path = `/v2/tasks/${encodeURIComponent(taskId)}/run`;
      const payload = await this.request('POST', path, {
        session_id: sessionId,
        input_params: { ...options.inputs, ...fileInputs(options.files) },
        sync: true,
        cleanup_sessions: false,
      }, timeoutMs);

      const run = record(payload, `${task.name} run`);
      if (run.status !== undefined && run.status !== 'success') {
        throw new Error(
          typeof run.error === 'string' ? run.error : `${task.name} ended with status ${String(run.status)}`,
        );
      }
      const output = unwrapTaskOutput(run.result ?? run.output ?? run, task.outputSchema.map((field) => field.name));
      return task.parse(output);
    } finally {
      await this.request('DELETE', `/sessions/${encodeURIComponent(sessionId)}`).catch(() => undefined);
    }
  }

  private async createSession(identityId: string): Promise<string> {
    const body = record(
      await this.request('POST', '/sessions', {
        identities: [{ id: identityId }],
        identity_skip_validation: true,
        session: { timeout: { max_duration: 180, idle_timeout: 120 } },
      }, this.config.taskTimeoutMs),
      'session',
    );
    return stringField(record(body.data, 'session.data'), 'id', 'session.data');
  }

  private async ensureTask(
    task: TaskDefinition<unknown>,
    applicationId: string,
    identityId: string,
    timeoutMs: number,
  ): Promise<string> {
    const existing = await this.listTasks(task.name);
    if (existing.length > 1) {
      throw new Error(`Anchor task name is ambiguous: ${task.name}`);
    }
    const current = existing[0];
    const reusable = current && current.generationStatus !== 'failed'
      && (!task.code || await this.hasWorkflowCode(current.id, task));
    if (current && reusable) {
      if (current.aiFallbackEnabled !== task.aiFallback) {
        await this.request('PUT', `/task/${encodeURIComponent(current.id)}`, { ai_fallback_enabled: task.aiFallback });
      }
      if (current.latestVersion === 'draft') {
        return this.waitForTask(current.id, task.name, timeoutMs);
      }
      return current.id;
    }
    if (current) {
      await this.request('DELETE', `/task/${encodeURIComponent(current.id)}`);
    }
    if (task.code) {
      return this.createCodeTask(task, applicationId);
    }

    const body = record(
      await this.request('POST', '/v2/tasks/generate', {
        taskName: task.name,
        description: task.description,
        taskPrompt: task.prompt,
        application_id: applicationId,
        identity_id: identityId,
        input_schema: task.inputSchema,
        output_schema: task.outputSchema,
        ai_fallback_enabled: task.aiFallback,
        retries: 0,
      }, timeoutMs),
      `${task.name} generation`,
    );
    const taskId = optionalStringField(body, 'taskId', 'id');
    if (!taskId) throw new Error(`Anchor task generation did not return an ID for ${task.name}`);
    return this.waitForTask(taskId, task.name, timeoutMs);
  }

  /**
   * A task authored in code is uploaded as a one-segment Anchor workflow: the
   * segment runs our Playwright function first and falls back to the agent
   * (guided by the prompt) only if that code throws.
   */
  private async createCodeTask(task: TaskDefinition<unknown>, applicationId: string): Promise<string> {
    const body = record(
      await this.request('POST', '/task', {
        name: task.name,
        description: task.description,
        language: 'workflow',
        code: Buffer.from(workflowCode(task), 'utf8').toString('base64'),
        application_id: applicationId,
        ai_fallback_enabled: task.aiFallback,
        retries: 0,
      }),
      `${task.name} creation`,
    );
    const created = body.data && typeof body.data === 'object' ? record(body.data, `${task.name} creation`) : body;
    const taskId = stringField(created, 'id', `${task.name} creation`);
    await this.request('POST', `/v2/tasks/${encodeURIComponent(taskId)}/publish-draft`, {});
    return taskId;
  }

  /** The code in this repo is the source of truth; a task with different code gets recreated. */
  private async hasWorkflowCode(taskId: string, task: TaskDefinition<unknown>): Promise<boolean> {
    const body = record(await this.request('GET', `/task/${encodeURIComponent(taskId)}?include=code`), 'task');
    const detail = body.data && typeof body.data === 'object' ? record(body.data, 'task.data') : body;
    if (typeof detail.code !== 'string' || !detail.code) return false;
    const encoded = /^[A-Za-z0-9+/]*={0,2}$/.test(detail.code) && !detail.code.startsWith('{');
    const code = encoded ? Buffer.from(detail.code, 'base64').toString('utf8') : detail.code;
    return code === workflowCode(task);
  }

  private async listTasks(name: string): Promise<AnchorTask[]> {
    const body = record(await this.request('GET', `/task?name=${encodeURIComponent(name)}&limit=100`), 'tasks');
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? (body.data as Record<string, unknown>)
      : body;
    if (!Array.isArray(data.tasks)) {
      throw new Error('Anchor returned an invalid tasks response');
    }
    return data.tasks.map((item, index) => parseTask(item, `tasks[${index}]`));
  }

  /**
   * Poll generation status until the task is ready. A freshly generated task
   * can briefly 404 (or be re-created under a new ID), so look it up by name
   * a few times before giving up.
   */
  private async waitForTask(taskId: string, taskName: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let notFound = 0;
    while (Date.now() <= deadline) {
      let status: Record<string, unknown>;
      try {
        status = record(
          await this.request('GET', `/v2/tasks/${encodeURIComponent(taskId)}/generation-status`),
          'task generation status',
        );
      } catch (error) {
        if (!(error instanceof AnchorApiError) || error.status !== 404) throw error;
        notFound += 1;
        if (notFound >= 5) throw error;
        const [replacement] = await this.listTasks(taskName);
        if (replacement && replacement.id !== taskId) {
          taskId = replacement.id;
          notFound = 0;
          continue;
        }
        await sleep(this.config.taskPollIntervalMs);
        continue;
      }
      if (status.status === 'ready') return taskId;
      if (status.status === 'failed') {
        throw new Error(
          typeof status.error === 'string'
            ? `Anchor task generation failed: ${status.error}`
            : 'Anchor task generation failed',
        );
      }
      await sleep(this.config.taskPollIntervalMs);
    }
    throw new Error(`Timed out waiting for Anchor task ${taskId} to become ready`);
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.config.requestTimeoutMs,
  ): Promise<unknown> {
    return this.send(method, path, {
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, timeoutMs);
  }

  private async send(
    method: string,
    path: string,
    init: { headers: Record<string, string>; body?: BodyInit },
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const baseUrl = path.startsWith('/v2/') ? this.v2BaseUrl : this.v1BaseUrl;
    try {
      const response = await this.fetcher(`${baseUrl}${path}`, {
        method,
        headers: { accept: 'application/json', 'anchor-api-key': this.config.anchorApiKey, ...init.headers },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new AnchorApiError(
          `Anchor API ${response.status} ${method} ${path}: ${text.slice(0, 300)}`,
          response.status,
          method,
          path,
        );
      }
      if (!text) return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`Anchor returned invalid JSON for ${method} ${path}`);
      }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Anchor request timed out: ${method} ${path}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
