import type {
  AnchorApplication,
  AnchorFile,
  AnchorClient,
  AnchorIdentity,
  AnchorTask,
  GaugeContentTaskResult,
  IdentityLink,
  MonitorConfig,
  PublishRequest,
  ReauthenticationResult,
} from './types.js';

const VALIDATION_OUTPUT_SCHEMA = [
  {
    name: 'authenticated',
    type: 'boolean',
    description: 'Whether the DOM shows an authenticated user session',
  },
];

const GAUGE_CONTENT_OUTPUT_SCHEMA = [
  {
    name: 'ticket_url',
    type: 'string',
    description: 'URL of the selected write-content ticket, or the current Gauge URL if none exists',
  },
  {
    name: 'article_title',
    type: 'string',
    description: 'Title of the article from the content ticket',
  },
  {
    name: 'article_summary',
    type: 'string',
    description: 'Concise summary of the article content',
  },
  {
    name: 'research_completed',
    type: 'boolean',
    description: 'Whether research is complete',
  },
  {
    name: 'outline_completed',
    type: 'boolean',
    description: 'Whether outline is complete',
  },
  {
    name: 'published',
    type: 'boolean',
    description: 'Must remain false because publishing is prohibited',
  },
  {
    name: 'message',
    type: 'string',
    description: 'Concise task result',
  },
];

function validationTaskPrompt(source: string): string {
  const gaugeChecks = source.includes('app.withgauge.com')
    ? `
Gauge-specific authenticated markers:
- visible navigation or text for Triage
- visible navigation or text for Tasks
- a visible Generate Now control
- a visible Ask Gauge input
Use separate valid Playwright locators for these checks, such as getByText or
getByPlaceholder. Do not combine Playwright text= selectors with CSS selectors
in a comma-separated selector. Treat Gauge as authenticated when at least one
Gauge-specific marker is visible and no login state is visible.`
    : '';
  return `Objective:
Check whether the current user is authenticated on ${source}.

Start URL:
${source}

Steps:
1. Wait for the page to finish loading.
2. Inspect the DOM only. Do not use an AI agent, click, submit, fill, or navigate.
3. Treat a visible app shell as authenticated. Check visible navigation/sidebar/workspace
   elements and visible text such as workspace, projects, dashboard, settings, account,
   sign out, or log out. Hidden text does not count.
${gaugeChecks}
4. Return authenticated=false when visible sign-in/login controls, a password form,
   registration, password-reset, access-denied, or login-required state is present,
   or when the URL is a login route. Ignore incidental article or help text mentioning
   "log in" or "sign in".
5. Return an object with the exact boolean field authenticated.

Output:
- authenticated (boolean)`;
}

function gaugeContentTaskPrompt(): string {
  return `Objective:
Process one currently open Gauge "write content" ticket through research and outline,
then stop before publishing the article. The task must be safe to rerun when some stages
are already complete.

Start URL:
https://app.withgauge.com

Steps:
1. Inspect the current Gauge workspace and navigate to Triage. If a Generate Now action
   is available and has not already been completed for the current triage item, click
   Generate Now once. If generation is already complete or in progress, do not click it again.
   If it got tasks pending, click accept on all of them until there are no more.
2. Wait generously for Gauge research to finish: allow up to 5 minutes, checking visible
   progress rather than restarting the operation.
3. Navigate to Tasks and open the Todo stack or Todo section before looking for a ticket.
   Find an open ticket whose task is to write content inside Todo. Never select a ticket
   from Completed, Done, Published, Archived, or any other completed stack, even if it
   still appears in the task list. If there are multiple eligible Todo write-content tickets,
   use the first one shown. Do not create a new ticket.
4. Open the Todo ticket and verify that its section/status is Todo or open before acting.
   If the ticket is completed, published, done, archived, or not in Todo, ignore it and
   continue searching only within Todo.
5. If Research is incomplete, complete or wait for the Research stage. If Research is already
   complete, preserve it and continue.
6. If Outline is incomplete, complete the Outline stage. If Outline is already complete,
   preserve it and continue.
7. Do not click Publish Article, do not submit publication, and do not make any irreversible
   publishing change. Stop immediately before publishing.
8. Return the current ticket page URL, the article title, a concise summary of the content,
   and the completion state of research, outline, and publishing.

Important behavior:
- Reuse Research and Outline work already complete on the selected Todo ticket; never restart
  research, select a completed-stack ticket, or duplicate a ticket.
- Research may take up to 5 minutes. Use generous waits and inspect visible progress after each wait.
- If no eligible Todo write-content ticket exists, return the current Gauge URL, use "No article found"
  as the title, use a concise "No open write-content ticket was found" summary, and explain
  that no ticket was found.

Output:
- ticket_url (string)
- article_title (string)
- article_summary (string)
- research_completed (boolean)
- outline_completed (boolean)
- published (boolean): must remain false
- message (string)`;
}

const GAUGE_PUBLISH_OUTPUT_SCHEMA = [
  { name: 'article_url', type: 'string', description: 'The newly published article URL' },
  { name: 'published', type: 'boolean', description: 'Whether publishing completed' },
  { name: 'message', type: 'string', description: 'Concise publish result' },
];

const SEARCH_CONSOLE_OUTPUT_SCHEMA = [
  { name: 'indexing_requested', type: 'boolean', description: 'Whether indexing was requested' },
  { name: 'message', type: 'string', description: 'Concise indexing result' },
];

function gaugePublishTaskPrompt(): string {
  return `Objective:
Publish one Gauge article from an existing Gauge content ticket. The ticket URL is the
authoritative starting point and must be opened before taking any other action.

Start URL:
https://app.withgauge.com

Inputs:
- ticket_url: the Gauge ticket URL
- article_title: the article title
- article_summary: the article summary
- destination: exactly one of blogs, templates hubs, guides
- author: use Idan Raman
- thumbnail_file: the selected thumbnail image provided as a file input

Steps:
1. Navigate directly to ticket_url as the first page navigation. Do not open an Actions menu
   or use any other navigation before opening the ticket.
2. Inspect the ticket's current status:
   - If the ticket is already published or completed, do not make any changes. Return the
     existing article URL when visible, published=true, and a message that it was already published.
   - Otherwise continue only if the ticket is open and in the Todo section. If it is not in
     Todo, stop without changes and return published=false.
3. Open the ticket's Publish to Article flow.
4. Choose the exact destination from the destination input.
5. Set the author to Idan Raman.
6. Choose the most relevant existing tag from the tags dropdown based on the article content. Never
   create a new tag and never select an unrelated tag.
7. Upload the provided thumbnail_file using the article thumbnail upload control. Wait for the
   upload to finish and verify the selected filename or image preview is visible before continuing.
   If the upload control, file, or preview is unavailable, stop without publishing and report it.
8. Review the article details and click Publish Now exactly once.
9. Wait for the published article URL. Open the resulting article and follow any redirect
   before returning the URL. Use the browser's final URL or the page's canonical link.
   For this site, the public canonical host is anchorbrowser.io, so do not return a
   www.anchorbrowser.com redirect URL. Return the final canonical article URL with
   published=true.

Safety:
- Never publish a ticket outside Todo.
- Never click Publish Now more than once and never click it for an already published ticket.
- If any required choice is unavailable or ambiguous, stop without publishing and report it.

Output:
- article_url (string)
- published (boolean)
- message (string)`;
}

function searchConsoleIndexTaskPrompt(): string {
  return `Objective:
Request indexing for one newly published article in Google Search Console.

Start URL:
https://search.google.com/search-console

Input:
- article_url: the exact URL to inspect

Steps:
1. Wait for the Search Console page to finish loading. Do not use the browser address bar
   for inspection.
2. Select the Search Console property that covers the exact article URL. For articles under
   anchorbrowser.io, use the URL-prefix property https://anchorbrowser.io/.
   Do not inspect the URL under a different property. If that property is unavailable,
   return indexing_requested=false and explain that the property is not available.
3. Find the page's URL inspection field. It is the wide field at the top of the Search Console
   page whose placeholder or accessible label contains "Inspect any URL" or "Inspect URL".
4. Click that inspection field, enter the exact article_url, and submit it with Enter or the
   field's Inspect/Run inspection control.
5. Wait until the URL inspection result is fully loaded.
6. If the result says the URL is already on Google or an indexing request is already pending,
   return indexing_requested=true with that status and do not submit a duplicate request.
7. Otherwise click Request indexing, wait for the confirmation dialog, click the confirmation
   control once, and wait for the request accepted/completed message.
8. Return whether the indexing request was accepted and a concise message. If the inspection
   field or Request indexing control cannot be found, return indexing_requested=false with a
   precise failure message.

Output:
- indexing_requested (boolean)
- message (string)`;
}
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

function booleanField(value: Record<string, unknown>, key: string, context: string): boolean {
  if (typeof value[key] !== 'boolean') {
    throw new Error(`Anchor returned an invalid ${context}.${key}`);
  }
  return value[key] as boolean;
}

function contentResultRecord(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try {
      return contentResultRecord(JSON.parse(value) as unknown);
    } catch {
      throw new Error('Anchor content task returned invalid JSON output');
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const result = value as Record<string, unknown>;
    if (
      'ticket_url' in result ||
      'research_completed' in result ||
      'outline_completed' in result ||
      'published' in result ||
      'message' in result
    ) {
      return result;
    }
    for (const key of ['result', 'data', 'output', 'value']) {
      if (key in result) return contentResultRecord(result[key]);
    }
  }
  throw new Error('Anchor content task returned no structured result');
}

function nullableStringField(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string | null {
  if (value[key] !== null && typeof value[key] !== 'string') {
    throw new Error(`Anchor returned an invalid ${context}.${key}`);
  }
  return (value[key] as string | null | undefined) ?? null;
}

function statusField(value: Record<string, unknown>, context: string): AnchorIdentity['status'] {
  const status = value.status;
  if (
    status !== 'active' &&
    status !== 'pending' &&
    status !== 'validated' &&
    status !== 'agent_invalid' &&
    status !== 'agent_failed' &&
    status !== 'failed'
  ) {
    throw new Error(`Anchor returned an invalid ${context}.status`);
  }
  return status;
}

function parseApplication(value: unknown, context: string): AnchorApplication {
  const application = record(value, context);
  return {
    id: stringField(application, 'id', context),
    name: stringField(application, 'name', context),
    url: nullableStringField(application, 'url', context),
    ...(typeof application.identity_count === 'number'
      ? { identityCount: application.identity_count }
      : {}),
  };
}

function parseTask(value: unknown, context: string): AnchorTask {
  const task = record(value, context);
  return {
    id: stringField(task, 'id', context),
    name: stringField(task, 'name', context),
    ...(typeof task.latestVersion === 'string'
      ? { latestVersion: task.latestVersion }
      : typeof task.latest_version === 'string'
        ? { latestVersion: task.latest_version }
        : {}),
    ...(typeof task.aiFallbackEnabled === 'boolean'
      ? { aiFallbackEnabled: task.aiFallbackEnabled }
      : typeof task.ai_fallback_enabled === 'boolean'
        ? { aiFallbackEnabled: task.ai_fallback_enabled }
        : {}),
    ...(typeof task.selectedTaskVersion === 'string'
      ? { generationStatus: task.selectedTaskVersion }
      : typeof task.status === 'string'
        ? { generationStatus: task.status }
        : {}),
  };
}

function parseValidationOutput(value: unknown): boolean | undefined {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    try {
      return parseValidationOutput(JSON.parse(value) as unknown);
    } catch {
      return false;
    }
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>;
  for (const key of [
    'authenticated',
    'is_authenticated',
    'isAuthenticated',
    'login_succeeded',
    'already_logged_in',
    'logged_in',
    'loggedIn',
  ]) {
    if (key in result) {
      const parsed = parseValidationOutput(result[key]);
      if (parsed !== undefined) return parsed;
    }
  }
  for (const key of ['result', 'data', 'output', 'outputs', 'value', 'answer']) {
    if (key in result) {
      const parsed = parseValidationOutput(result[key]);
      if (parsed !== undefined) return parsed;
    }
  }
  return undefined;
}

export class HttpAnchorClient implements AnchorClient {
  private readonly v1BaseUrl: string;
  private readonly v2BaseUrl: string;

  constructor(
    private readonly config: Pick<
      MonitorConfig,
      | 'anchorApiBase'
      | 'anchorApiKey'
      | 'requestTimeoutMs'
      | 'reauthTimeoutMs'
      | 'taskPollIntervalMs'
      | 'contentTaskTimeoutMs'
    >,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    const configuredBaseUrl = config.anchorApiBase.replace(/\/+$/, '');
    this.v1BaseUrl = configuredBaseUrl.endsWith('/v1')
      ? configuredBaseUrl
      : `${configuredBaseUrl}/v1`;
    this.v2BaseUrl = configuredBaseUrl.replace(/\/v1$/, '');
  }

  async listApplications(search?: string): Promise<AnchorApplication[]> {
    const query = search ? `?search=${encodeURIComponent(search)}` : '';
    const payload = await this.request('GET', `/applications${query}`);
    const body = record(payload, 'applications');
    if (!Array.isArray(body.applications)) {
      throw new Error('Anchor returned an invalid applications response');
    }

    return body.applications.map((item, index) =>
      parseApplication(item, `applications[${index}]`),
    );
  }

  async createApplication(source: string, name: string): Promise<AnchorApplication> {
    return parseApplication(
      await this.request('POST', '/applications', { source, name }),
      'application',
    );
  }

  async validateIdentity(
    identityId: string,
    source: string,
    applicationId: string,
    taskName: string,
  ): Promise<boolean> {
    const sourceUrl = /^[a-z][a-z\d+\-.]*:\/\//i.test(source)
      ? source
      : `https://${source}`;
    const sessionPayload = await this.request('POST', '/sessions', {
      identities: [{ id: identityId }],
      identity_skip_validation: true,
      session: {
        timeout: {
          max_duration: 180,
          idle_timeout: 60,
        },
      },
    }, this.config.reauthTimeoutMs);
    const sessionBody = record(sessionPayload, 'session');
    const sessionData = record(sessionBody.data, 'session.data');
    const sessionId = stringField(sessionData, 'id', 'session.data');

    try {
      const taskId = await this.ensureValidationTask(
        taskName,
        sourceUrl,
        applicationId,
        identityId,
      );
      const taskPayload = await this.request(
        'POST',
        `/v2/tasks/${encodeURIComponent(taskId)}/run`,
        {
          session_id: sessionId,
          input_params: {},
          sync: true,
          cleanup_sessions: false,
        },
        this.config.reauthTimeoutMs,
      );
      const taskResult = record(taskPayload, 'task run');
      if (taskResult.status !== undefined && taskResult.status !== 'success') {
        throw new Error(
          typeof taskResult.error === 'string'
            ? taskResult.error
            : `Anchor validation task ended with status ${String(taskResult.status)}`,
        );
      }
      const authenticated = parseValidationOutput(
        taskResult.result ?? taskResult.output ?? taskResult,
      );
      if (authenticated === undefined) {
        throw new Error('Anchor validation task returned no authenticated boolean');
      }
      return authenticated;
    } finally {
      await this.request(
        'DELETE',
        `/sessions/${encodeURIComponent(sessionId)}`,
      ).catch(() => undefined);
    }
  }

  async runGaugeContentTask(
    applicationId: string,
    identityId: string,
    taskName: string,
  ): Promise<GaugeContentTaskResult | null> {
    const taskId = await this.ensureGaugeContentTask(taskName, applicationId, identityId);
    const payload = await this.request(
      'POST',
      `/v2/tasks/${encodeURIComponent(taskId)}/run`,
      {
        identity_id: identityId,
        input_params: {},
        sync: true,
        cleanup_sessions: true,
      },
      this.config.contentTaskTimeoutMs,
    );
    const taskResult = record(payload, 'Gauge content task run');
    if (taskResult.status !== undefined && taskResult.status !== 'success') {
      throw new Error(
        typeof taskResult.error === 'string'
          ? taskResult.error
          : `Gauge content task ended with status ${String(taskResult.status)}`,
      );
    }
    const result = contentResultRecord(taskResult.result ?? taskResult.output ?? taskResult);
    const output: GaugeContentTaskResult = {
      ticketUrl: stringField(result, 'ticket_url', 'Gauge content task result'),
      articleTitle: stringField(result, 'article_title', 'Gauge content task result'),
      articleSummary: stringField(result, 'article_summary', 'Gauge content task result'),
      researchCompleted: booleanField(result, 'research_completed', 'Gauge content task result'),
      outlineCompleted: booleanField(result, 'outline_completed', 'Gauge content task result'),
      published: booleanField(result, 'published', 'Gauge content task result'),
      message: stringField(result, 'message', 'Gauge content task result'),
    };
    if (output.published) {
      throw new Error('Gauge content task reported an unsafe published=true result');
    }
    if (output.articleTitle.trim().toLocaleLowerCase() === 'no article found') {
      return null;
    }
    return output;
  }

  async publishGaugeArticle(
    applicationId: string,
    identityId: string,
    taskName: string,
    input: PublishRequest,
    thumbnail: AnchorFile,
  ): Promise<string> {
    const sessionId = await this.createIdentitySession(identityId);
    try {
      const taskId = await this.ensureAutomationTask(
        taskName,
        applicationId,
        identityId,
        'Publish a Gauge Todo article with a selected thumbnail.',
        gaugePublishTaskPrompt(),
        [
          { name: 'ticket_url', type: 'string', description: 'Gauge ticket URL' },
          { name: 'article_title', type: 'string', description: 'Article title' },
          { name: 'article_summary', type: 'string', description: 'Article summary' },
          { name: 'destination', type: 'string', description: 'blogs, templates hubs, or guides' },
          { name: 'author', type: 'string', description: 'Required author name' },
          { name: 'thumbnail_file', type: 'file', description: 'Selected article thumbnail' },
        ],
        GAUGE_PUBLISH_OUTPUT_SCHEMA,
        applicationId,
        identityId,
        this.config.contentTaskTimeoutMs,
      );
      const payload = await this.requestMultipart(
        `/v2/tasks/${encodeURIComponent(taskId)}/run`,
        {
          session_id: sessionId,
          sync: 'true',
          cleanup_sessions: 'false',
          identity_skip_validation: 'true',
          input_params: JSON.stringify({
            ticket_url: input.ticketUrl,
            article_title: input.articleTitle,
            article_summary: input.articleSummary,
            destination: input.destination,
            author: 'Idan Raman',
          }),
        },
        thumbnail,
        this.config.contentTaskTimeoutMs,
      );
      const taskResult = record(payload, 'Gauge publish task run');
      if (taskResult.status !== undefined && taskResult.status !== 'success') {
        throw new Error(
          typeof taskResult.error === 'string'
            ? taskResult.error
            : `Gauge publish task ended with status ${String(taskResult.status)}`,
        );
      }
      const result = contentResultRecord(taskResult.result ?? taskResult.output ?? taskResult);
      const published = booleanField(result, 'published', 'Gauge publish task result');
      if (!published) {
        throw new Error(
          `Gauge publish task did not publish: ${
            typeof result.message === 'string' ? result.message : 'no reason returned'
          }`,
        );
      }
      return stringField(result, 'article_url', 'Gauge publish task result');
    } finally {
      await this.request(
        'DELETE',
        `/sessions/${encodeURIComponent(sessionId)}`,
      ).catch(() => undefined);
    }
  }

  async requestSearchConsoleIndexing(
    applicationId: string,
    identityId: string,
    taskName: string,
    articleUrl: string,
  ): Promise<{ requested: boolean; message: string }> {
    const sessionId = await this.createIdentitySession(identityId);
    try {
      const taskId = await this.ensureAutomationTask(
        taskName,
        applicationId,
        identityId,
        'Request Google Search Console indexing for a published article URL.',
        searchConsoleIndexTaskPrompt(),
        [{ name: 'article_url', type: 'string', description: 'Published article URL' }],
        SEARCH_CONSOLE_OUTPUT_SCHEMA,
        applicationId,
        identityId,
        this.config.reauthTimeoutMs,
      );
      const payload = await this.request(
        'POST',
        `/v2/tasks/${encodeURIComponent(taskId)}/run`,
        {
          session_id: sessionId,
          input_params: { article_url: articleUrl },
          sync: true,
          cleanup_sessions: false,
        },
        this.config.reauthTimeoutMs,
      );
      const taskResult = record(payload, 'Search Console indexing task run');
      if (taskResult.status !== undefined && taskResult.status !== 'success') {
        throw new Error(
          typeof taskResult.error === 'string'
            ? taskResult.error
            : `Search Console indexing task ended with status ${String(taskResult.status)}`,
        );
      }
      const result = contentResultRecord(taskResult.result ?? taskResult.output ?? taskResult);
      return {
        requested: booleanField(result, 'indexing_requested', 'Search Console indexing result'),
        message: stringField(result, 'message', 'Search Console indexing result'),
      };
    } finally {
      await this.request(
        'DELETE',
        `/sessions/${encodeURIComponent(sessionId)}`,
      ).catch(() => undefined);
    }
  }

  private async ensureGaugeContentTask(
    taskName: string,
    applicationId: string,
    identityId: string,
  ): Promise<string> {
    const existing = await this.listTasks(taskName);
    if (existing.length > 1) {
      throw new Error(`Gauge content task name is ambiguous: ${taskName}`);
    }
    if (existing.length === 1) {
      const task = existing[0] as AnchorTask;
      if (task.generationStatus === 'failed') {
        await this.request('DELETE', `/task/${encodeURIComponent(task.id)}`);
      } else {
        if (task.latestVersion === 'draft') {
          await this.waitForTask(task.id, this.config.contentTaskTimeoutMs, taskName);
        }
        return task.id;
      }
    }

    const payload = await this.request(
      'POST',
      '/v2/tasks/generate',
      {
        taskName,
        description: 'Research and outline an open Gauge write-content ticket without publishing.',
        taskPrompt: gaugeContentTaskPrompt(),
        application_id: applicationId,
        identity_id: identityId,
        input_schema: [],
        output_schema: GAUGE_CONTENT_OUTPUT_SCHEMA,
        ai_fallback_enabled: true,
        retries: 0,
        task_browser_default_configuration: {
          session: {
            timeout: {
              max_duration: 30,
              idle_timeout: 120,
            },
          },
        },
      },
      this.config.contentTaskTimeoutMs,
    );
    const body = record(payload, 'Gauge content task generation');
    const taskId =
      typeof body.taskId === 'string'
        ? body.taskId
        : typeof body.id === 'string'
          ? body.id
          : undefined;
    if (!taskId) throw new Error('Gauge content task generation did not return a task ID');
    return this.waitForTask(taskId, this.config.contentTaskTimeoutMs, taskName);
  }

  private async ensureAutomationTask(
    taskName: string,
    applicationId: string,
    identityId: string,
    description: string,
    taskPrompt: string,
    inputSchema: unknown[],
    outputSchema: unknown[],
    taskApplicationId: string,
    taskIdentityId: string,
    timeoutMs: number,
  ): Promise<string> {
    const existing = await this.listTasks(taskName);
    if (existing.length > 1) {
      throw new Error(`Anchor automation task name is ambiguous: ${taskName}`);
    }
    if (existing.length === 1) {
      const task = existing[0] as AnchorTask;
      if (task.generationStatus === 'failed') {
        await this.request('DELETE', `/task/${encodeURIComponent(task.id)}`);
      } else {
        if (task.latestVersion === 'draft') {
          await this.waitForTask(task.id, timeoutMs, taskName);
        }
        return task.id;
      }
    }
    const payload = await this.request(
      'POST',
      '/v2/tasks/generate',
      {
        taskName,
        description,
        taskPrompt,
        application_id: taskApplicationId || applicationId,
        identity_id: taskIdentityId || identityId,
        input_schema: inputSchema,
        output_schema: outputSchema,
        ai_fallback_enabled: true,
        retries: 0,
      },
      timeoutMs,
    );
    const body = record(payload, `${taskName} generation`);
    const taskId =
      typeof body.taskId === 'string'
        ? body.taskId
        : typeof body.id === 'string'
          ? body.id
          : undefined;
    if (!taskId) throw new Error(`Anchor task generation did not return an ID for ${taskName}`);
    return this.waitForTask(taskId, timeoutMs, taskName);
  }

  private async createIdentitySession(identityId: string): Promise<string> {
    const payload = await this.request(
      'POST',
      '/sessions',
      {
        identities: [{ id: identityId }],
        identity_skip_validation: true,
        session: {
          timeout: {
            max_duration: 180,
            idle_timeout: 120,
          },
        },
      },
      this.config.contentTaskTimeoutMs,
    );
    const body = record(payload, 'session');
    const data = record(body.data, 'session.data');
    return stringField(data, 'id', 'session.data');
  }

  private async ensureValidationTask(
    taskName: string,
    source: string,
    applicationId: string,
    identityId: string,
  ): Promise<string> {
    const existing = await this.listTasks(taskName);
    if (existing.length > 1) {
      throw new Error(`Anchor validation task name is ambiguous: ${taskName}`);
    }

    if (existing.length === 1) {
      const task = existing[0] as AnchorTask;
      if (task.aiFallbackEnabled !== false) {
        await this.request('PUT', `/task/${encodeURIComponent(task.id)}`, {
          ai_fallback_enabled: false,
        });
      }
      if (task.latestVersion === 'draft') {
        await this.waitForTask(task.id, this.config.reauthTimeoutMs, taskName);
      }
      return task.id;
    }

    const payload = await this.request(
      'POST',
      '/v2/tasks/generate',
      {
        taskName,
        description: `Deterministic DOM authentication check for ${source}`,
        taskPrompt: validationTaskPrompt(source),
        application_id: applicationId,
        identity_id: identityId,
        input_schema: [],
        output_schema: VALIDATION_OUTPUT_SCHEMA,
        ai_fallback_enabled: false,
        retries: 0,
      },
      this.config.reauthTimeoutMs,
    );
    const body = record(payload, 'task generation');
    const taskId =
      typeof body.taskId === 'string'
        ? body.taskId
        : typeof body.id === 'string'
          ? body.id
          : undefined;
    if (!taskId) throw new Error('Anchor task generation did not return a task ID');
    return this.waitForTask(taskId, this.config.reauthTimeoutMs, taskName);
  }

  private async listTasks(name: string): Promise<AnchorTask[]> {
    const payload = await this.request(
      'GET',
      `/task?name=${encodeURIComponent(name)}&limit=100`,
    );
    const body = record(payload, 'tasks');
    const data = body.data && typeof body.data === 'object' && !Array.isArray(body.data)
      ? body.data as Record<string, unknown>
      : body;
    if (!Array.isArray(data.tasks)) {
      throw new Error('Anchor returned an invalid tasks response');
    }
    return data.tasks.map((item, index) => parseTask(item, `tasks[${index}]`));
  }

  private async waitForTask(
    taskId: string,
    timeoutMs = this.config.reauthTimeoutMs,
    taskName?: string,
  ): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let notFoundAttempts = 0;
    while (Date.now() <= deadline) {
      let payload: unknown;
      try {
        payload = await this.request(
          'GET',
          `/v2/tasks/${encodeURIComponent(taskId)}/generation-status`,
        );
      } catch (error) {
        if (!(error instanceof AnchorApiError) || error.status !== 404) {
          throw error;
        }
        if (taskName) {
          const tasks = await this.listTasks(taskName);
          if (tasks.length !== 1) {
            notFoundAttempts += 1;
            if (notFoundAttempts >= 5) throw error;
            await new Promise((resolve) => setTimeout(resolve, this.config.taskPollIntervalMs));
            continue;
          }
          const [replacementTask] = tasks;
          if (!replacementTask) throw error;
          if (replacementTask.id !== taskId) {
            taskId = replacementTask.id;
            notFoundAttempts = 0;
            continue;
          }
        }
        notFoundAttempts += 1;
        if (notFoundAttempts >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, this.config.taskPollIntervalMs));
        continue;
      }
      const body = record(payload, 'task generation status');
      const status = body.status;
      if (status === 'ready') return taskId;
      if (status === 'failed') {
        throw new Error(
          typeof body.error === 'string'
            ? `Anchor task generation failed: ${body.error}`
            : 'Anchor task generation failed',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.config.taskPollIntervalMs));
    }
    throw new Error(`Timed out waiting for Anchor task ${taskId} to become ready`);
  }

  async listIdentities(applicationId: string): Promise<AnchorIdentity[]> {
    const payload = await this.request(
      'GET',
      `/applications/${encodeURIComponent(applicationId)}/identities`,
    );
    const body = record(payload, 'identities');
    if (!Array.isArray(body.identities)) {
      throw new Error('Anchor returned an invalid identities response');
    }

    return body.identities.map((item, index) => {
      const identity = record(item, `identities[${index}]`);
      return {
        id: stringField(identity, 'id', `identities[${index}]`),
        name: stringField(identity, 'name', `identities[${index}]`),
        status: statusField(identity, `identities[${index}]`),
        ...(typeof identity.updated_at === 'string' ? { updatedAt: identity.updated_at } : {}),
      };
    });
  }

  async createIdentityLink(applicationId: string, userName?: string): Promise<IdentityLink> {
    const body = userName ? { user_name: userName } : {};
    return this.parseLink(
      await this.request(
        'POST',
        `/applications/${encodeURIComponent(applicationId)}/identity-links`,
        body,
      ),
      'identity',
    );
  }

  async reauthenticate(identityId: string): Promise<ReauthenticationResult> {
    const payload = await this.request(
      'POST',
      `/identities/${encodeURIComponent(identityId)}/reauthenticate`,
      { sync: true },
      this.config.reauthTimeoutMs,
    );
    const body = record(payload, 'reauthentication');
    return {
      identityId:
        typeof body.identityId === 'string'
          ? body.identityId
          : typeof body.identity_id === 'string'
            ? body.identity_id
            : identityId,
      ...(typeof body.async === 'boolean' ? { async: body.async } : {}),
    };
  }

  async createReauthLink(
    identityId: string,
    authMethod: MonitorConfig['reauthAuthMethod'],
  ): Promise<IdentityLink> {
    return this.parseLink(
      await this.request(
        'POST',
        `/identities/${encodeURIComponent(identityId)}/reauth-links`,
        { authMethod },
      ),
      'reauth',
    );
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.config.requestTimeoutMs,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const baseUrl = path.startsWith('/v2/') ? this.v2BaseUrl : this.v1BaseUrl;
      const response = await this.fetcher(`${baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'anchor-api-key': this.config.anchorApiKey,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
      if (error instanceof AnchorApiError || error instanceof Error && error.name !== 'AbortError') {
        throw error;
      }
      throw new Error(`Anchor request timed out: ${method} ${path}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async requestMultipart(
    path: string,
    fields: Record<string, string>,
    file: AnchorFile,
    timeoutMs: number,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const baseUrl = path.startsWith('/v2/') ? this.v2BaseUrl : this.v1BaseUrl;
      const form = new FormData();
      for (const [key, value] of Object.entries(fields)) {
        form.append(key, value);
      }
      form.append(
        'thumbnail_file',
        new Blob([Buffer.from(file.data)], { type: file.mimeType }),
        file.fileName,
      );
      const response = await this.fetcher(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'anchor-api-key': this.config.anchorApiKey,
        },
        body: form,
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new AnchorApiError(
          `Anchor API ${response.status} POST ${path}: ${text.slice(0, 300)}`,
          response.status,
          'POST',
          path,
        );
      }
      if (!text) return {};
      try {
        return JSON.parse(text) as unknown;
      } catch {
        throw new Error(`Anchor returned invalid JSON for POST ${path}`);
      }
    } catch (error) {
      if (error instanceof AnchorApiError || error instanceof Error && error.name !== 'AbortError') {
        throw error;
      }
      throw new Error(`Anchor request timed out: POST ${path}`);
    } finally {
      clearTimeout(timeout);
    }
  }

  private parseLink(payload: unknown, kind: string): IdentityLink {
    const body = record(payload, `${kind} link`);
    return {
      url: stringField(body, `${kind}_url`, `${kind} link`),
      expiresAt: stringField(body, 'expires_at', `${kind} link`),
    };
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
