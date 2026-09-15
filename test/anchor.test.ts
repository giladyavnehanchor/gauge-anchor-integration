import { describe, expect, it, vi } from 'vitest';
import { AnchorApiError, HttpAnchorClient, generatedDescription, workflowCode } from '../src/anchor.js';
import { authCheck, gaugeFindArticle, gaugePublishArticle, searchConsoleRequestIndexing } from '../src/tasks.js';
import { testConfig } from './fakes.js';

const config = testConfig();
const gaugeTarget = config.targets[0]!;
const run = { applicationId: 'app-1', identityId: 'identity-1' };
const foundArticle = {
  ticket_url: 'https://app.withgauge.com/tasks/ticket-2',
  article_title: 'Generated article',
  article_summary: 'Generated summary',
  research_completed: true,
  outline_completed: true,
  article_written: true,
  published: false,
  message: 'Ready for review',
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function bodyOf(fetcher: ReturnType<typeof vi.fn<typeof fetch>>, call: number): string {
  return String(fetcher.mock.calls[call]?.[1]?.body);
}

describe('HttpAnchorClient', () => {
  it('uses the API key header and parses applications', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({ applications: [{ id: 'app-1', name: 'Gauge', url: 'https://gauge.example.com', identity_count: 1 }] }),
    );
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.listApplications('Gauge')).resolves.toEqual([
      { id: 'app-1', name: 'Gauge', url: 'https://gauge.example.com', identityCount: 1 },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.anchorbrowser.io/v1/applications?search=Gauge',
      expect.objectContaining({ headers: expect.objectContaining({ 'anchor-api-key': 'test-key' }) }),
    );
  });

  it('parses identities and links', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({ identities: [{ id: 'identity-1', name: 'Account', status: 'validated', updated_at: '2030-01-01' }] }),
      )
      .mockResolvedValueOnce(response({ identity_url: 'https://anchor.test/create', expires_at: '2030-01-02' }))
      .mockResolvedValueOnce(response({ reauth_url: 'https://anchor.test/reauth', expires_at: '2030-01-03' }));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.listIdentities('app-1')).resolves.toEqual([
      { id: 'identity-1', name: 'Account', status: 'validated', updatedAt: '2030-01-01' },
    ]);
    await expect(client.createIdentityLink('app-1', 'Owner')).resolves.toEqual({
      url: 'https://anchor.test/create',
      expiresAt: '2030-01-02',
    });
    await expect(client.createReauthLink('identity-1', 'profile')).resolves.toEqual({
      url: 'https://anchor.test/reauth',
      expiresAt: '2030-01-03',
    });
  });

  it('creates an application from a source URL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({ id: 'app-2', name: 'Gauge', url: 'app.withgauge.com', identity_count: 0 }),
    );
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.createApplication('https://app.withgauge.com', 'Gauge')).resolves.toEqual({
      id: 'app-2',
      name: 'Gauge',
      url: 'app.withgauge.com',
      identityCount: 0,
    });
    expect(bodyOf(fetcher, 0)).toBe(JSON.stringify({ source: 'https://app.withgauge.com', name: 'Gauge' }));
  });

  it('generates a missing task, waits for it, and runs it inside an identity session', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-1' } }))
      .mockResolvedValueOnce(response({ tasks: [] }))
      .mockResolvedValueOnce(response({ id: 'task-1', status: 'generating' }))
      .mockResolvedValueOnce(response({ status: 'generating' }))
      .mockResolvedValueOnce(response({ status: 'ready' }))
      .mockResolvedValueOnce(response({ status: 'success', result: { success: false, output: { authenticated: true } } }))
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.runTask(authCheck(gaugeTarget), run)).resolves.toBe(true);

    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls).toEqual([
      'https://api.anchorbrowser.io/v1/sessions',
      'https://api.anchorbrowser.io/v1/task?name=anchor-identity-monitor-gauge-dom-check&limit=100',
      'https://api.anchorbrowser.io/v2/tasks/generate',
      'https://api.anchorbrowser.io/v2/tasks/task-1/generation-status',
      'https://api.anchorbrowser.io/v2/tasks/task-1/generation-status',
      'https://api.anchorbrowser.io/v2/tasks/task-1/run',
      'https://api.anchorbrowser.io/v1/sessions/session-1',
    ]);
    expect(JSON.parse(bodyOf(fetcher, 2))).toMatchObject({
      taskName: 'anchor-identity-monitor-gauge-dom-check',
      ai_fallback_enabled: false,
      application_id: 'app-1',
      identity_id: 'identity-1',
      taskPrompt: expect.stringContaining('Triage'),
    });
    expect(JSON.parse(bodyOf(fetcher, 5))).toEqual({
      session_id: 'session-1',
      input_params: {},
      sync: true,
      cleanup_sessions: false,
    });
    expect(fetcher.mock.calls[6]?.[1]).toMatchObject({ method: 'DELETE' });
  });

  it('uploads a code task as a one-segment workflow instead of generating it', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-3' } }))
      .mockResolvedValueOnce(response({ tasks: [] }))
      .mockResolvedValueOnce(response({ id: 'task-code', name: searchConsoleRequestIndexing.name, latestVersion: 'draft' }))
      .mockResolvedValueOnce(response({ version: '1' }))
      .mockResolvedValueOnce(
        response({ status: 'success', result: { indexing_requested: true, message: 'Indexing requested' } }),
      )
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(
      client.runTask(searchConsoleRequestIndexing, { ...run, inputs: { article_url: 'https://anchorbrowser.io/blog/a' } }),
    ).resolves.toEqual({ requested: true, message: 'Indexing requested' });

    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls.slice(2, 5)).toEqual([
      'https://api.anchorbrowser.io/v1/task',
      'https://api.anchorbrowser.io/v2/tasks/task-code/publish-draft',
      'https://api.anchorbrowser.io/v2/tasks/task-code/run',
    ]);
    const created = JSON.parse(bodyOf(fetcher, 2));
    expect(created).toMatchObject({
      name: 'search-console-request-indexing',
      language: 'workflow',
      application_id: 'app-1',
      ai_fallback_enabled: true,
    });
    const workflow = JSON.parse(Buffer.from(created.code, 'base64').toString('utf8'));
    expect(workflow.startSegmentName).toBe('main');
    expect(workflow.segments).toHaveLength(1);
    expect(workflow.segments[0]).toMatchObject({
      type: 'ui',
      deterministic: searchConsoleRequestIndexing.code,
      prompt: expect.stringContaining('Request indexing'),
    });
    expect(workflow.inputParameters.map((p: { name: string; required: boolean }) => [p.name, p.required])).toEqual([
      ['article_url', true],
      ['property', false],
    ]);
    expect(JSON.parse(bodyOf(fetcher, 4)).input_params).toEqual({ article_url: 'https://anchorbrowser.io/blog/a' });
  });

  it('recreates a code task when the remote workflow no longer matches the repo code', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-4' } }))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'task-old', name: searchConsoleRequestIndexing.name, latestVersion: '1', aiFallbackEnabled: true }] }),
      )
      .mockResolvedValueOnce(response({ id: 'task-old', code: Buffer.from('{"old":true}').toString('base64') }))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ id: 'task-new', name: searchConsoleRequestIndexing.name, latestVersion: 'draft' }))
      .mockResolvedValueOnce(response({ version: '1' }))
      .mockResolvedValueOnce(response({ status: 'success', result: { indexing_requested: false, message: 'Quota exceeded' } }))
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(
      client.runTask(searchConsoleRequestIndexing, { ...run, inputs: { article_url: 'https://anchorbrowser.io/blog/a' } }),
    ).resolves.toEqual({ requested: false, message: 'Quota exceeded' });

    const calls = fetcher.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${String(url)}`);
    expect(calls.slice(2, 7)).toEqual([
      'GET https://api.anchorbrowser.io/v1/task/task-old?include=code',
      'DELETE https://api.anchorbrowser.io/v1/task/task-old',
      'POST https://api.anchorbrowser.io/v1/task',
      'POST https://api.anchorbrowser.io/v2/tasks/task-new/publish-draft',
      'POST https://api.anchorbrowser.io/v2/tasks/task-new/run',
    ]);
  });

  it('reuses a code task whose remote workflow matches the repo code', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-5' } }))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'task-same', name: searchConsoleRequestIndexing.name, latestVersion: '1', aiFallbackEnabled: true }] }),
      )
      .mockResolvedValueOnce(
        response({ id: 'task-same', code: Buffer.from(workflowCode(searchConsoleRequestIndexing)).toString('base64') }),
      )
      .mockResolvedValueOnce(response({ status: 'success', result: { indexing_requested: true, message: 'ok' } }))
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(
      client.runTask(searchConsoleRequestIndexing, { ...run, inputs: { article_url: 'https://anchorbrowser.io/blog/a' } }),
    ).resolves.toEqual({ requested: true, message: 'ok' });
    expect(String(fetcher.mock.calls[3]?.[0])).toBe('https://api.anchorbrowser.io/v2/tasks/task-same/run');
  });

  it('reuses an existing ready task without regenerating it', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-2' } }))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'task-existing', name: 'anchor-identity-monitor-gauge-dom-check', description: generatedDescription(authCheck(gaugeTarget)), latestVersion: 'latest', aiFallbackEnabled: false }] }),
      )
      .mockResolvedValueOnce(response({ status: 'success', result: { authenticated: false } }))
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.runTask(authCheck(gaugeTarget), run)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.map(([url]) => String(url))).not.toContain('https://api.anchorbrowser.io/v2/tasks/generate');
  });

  it('fixes the AI fallback flag on an existing task when it differs from the definition', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-2' } }))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'task-existing', name: 'anchor-identity-monitor-gauge-dom-check', description: generatedDescription(authCheck(gaugeTarget)), latestVersion: 'latest', aiFallbackEnabled: true }] }),
      )
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ status: 'success', result: { authenticated: true } }))
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await client.runTask(authCheck(gaugeTarget), run);

    expect(fetcher.mock.calls[2]?.[0]).toBe('https://api.anchorbrowser.io/v1/task/task-existing');
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ ai_fallback_enabled: false }) });
  });

  it('regenerates a task whose prompt fingerprint is stale', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-3b' } }))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'task-stale', name: gaugeFindArticle.name, description: 'Find [prompt 000000000000]', latestVersion: '1', aiFallbackEnabled: true }] }),
      )
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ taskId: 'task-fresh' }))
      .mockResolvedValueOnce(response({ status: 'ready' }))
      .mockResolvedValueOnce(response({ status: 'success', result: { ...foundArticle, article_title: 'Fresh article' } }))
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.runTask(gaugeFindArticle, run)).resolves.toMatchObject({ title: 'Fresh article' });
    expect(fetcher.mock.calls[2]?.[0]).toBe('https://api.anchorbrowser.io/v1/task/task-stale');
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(bodyOf(fetcher, 3)).toContain(generatedDescription(gaugeFindArticle));
  });

  it('chains code-authored segments and passes earlier outputs forward as inputs', () => {
    const workflow = JSON.parse(workflowCode(gaugePublishArticle));
    const names = (fields: { name: string }[]) => fields.map((field) => field.name);

    expect(workflow.startSegmentName).toBe('open_ticket');
    expect(workflow.segments.map((segment: { name: string; next: string | null }) => [segment.name, segment.next])).toEqual([
      ['open_ticket', 'prepare_publish'],
      ['prepare_publish', 'upload_thumbnail'],
      ['upload_thumbnail', 'publish'],
      ['publish', null],
    ]);
    const upload = workflow.segments[2];
    expect(upload.type).toBe('ui');
    expect(upload.deterministic).toContain('setInputFiles(parameters.thumbnail_file)');
    expect(names(upload.inputParameters)).toEqual(['thumbnail_file', 'already_published']);
    expect(upload.inputParameters[1]).toMatchObject({ type: 'boolean', required: true });
    expect(workflow.segments[1]).toMatchObject({ type: 'agent', deterministic: null });
    expect(names(workflow.segments[3].outputParameters)).toEqual(names(workflow.outputParameters));
  });

  it('rejects a segment input that no task input or earlier segment provides', () => {
    const broken = {
      ...gaugePublishArticle,
      segments: [{ name: 'only', type: 'agent' as const, prompt: 'x', inputs: ['nope'] }],
    };
    expect(() => workflowCode(broken)).toThrow('Segment only input "nope"');
  });

  it('deletes a failed task and generates a fresh one', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-3' } }))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'task-broken', name: 'gauge-content-research-outline', status: 'failed' }] }),
      )
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ taskId: 'task-fresh' }))
      .mockResolvedValueOnce(response({ status: 'ready' }))
      .mockResolvedValueOnce(
        response({
          status: 'success',
          result: {
            ticket_url: 'https://app.withgauge.com/tasks/ticket-2',
            article_title: 'Generated article',
            article_summary: 'Generated summary',
            research_completed: true,
            outline_completed: true,
            article_written: true,
            published: false,
            message: 'Ready for review',
          },
        }),
      )
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.runTask(gaugeFindArticle, run)).resolves.toMatchObject({ title: 'Generated article' });
    expect(fetcher.mock.calls[2]?.[0]).toBe('https://api.anchorbrowser.io/v1/task/task-broken');
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(bodyOf(fetcher, 3)).toContain('Completed, Done, Published');
  });

  it('retries a transient generation-status 404 and follows a replacement task ID', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-4' } }))
      .mockResolvedValueOnce(response({ tasks: [] }))
      .mockResolvedValueOnce(response({ id: 'task-4', status: 'generating' }))
      .mockResolvedValueOnce(response({ error: 'Task not found' }, 404))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'task-4b', name: 'anchor-identity-monitor-gauge-dom-check', latestVersion: 'draft' }] }),
      )
      .mockResolvedValueOnce(response({ status: 'ready' }))
      .mockResolvedValueOnce(response({ status: 'success', result: { authenticated: 'true' } }))
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.runTask(authCheck(gaugeTarget), run)).resolves.toBe(true);
    expect(fetcher.mock.calls[5]?.[0]).toBe('https://api.anchorbrowser.io/v2/tasks/task-4b/generation-status');
    expect(fetcher.mock.calls[6]?.[0]).toBe('https://api.anchorbrowser.io/v2/tasks/task-4b/run');
  });

  it('sends file inputs inside JSON input_params as named data URIs', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'publish-session' } }))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'publish-task', name: 'gauge-publish-article', latestVersion: '1', aiFallbackEnabled: true }] }),
      )
      .mockResolvedValueOnce(
        response({ id: 'publish-task', code: Buffer.from(workflowCode(gaugePublishArticle)).toString('base64') }),
      )
      .mockResolvedValueOnce(
        response({ status: 'success', result: { article_url: 'https://anchorbrowser.io/blog/article-1', published: true, message: 'Published' } }),
      )
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(
      client.runTask(gaugePublishArticle, {
        ...run,
        inputs: { ticket_url: 'https://app.withgauge.com/ticket-1', destination: 'blogs', author: 'Idan Raman' },
        files: { thumbnail_file: { fileName: 'thumb nail.png', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) } },
      }),
    ).resolves.toBe('https://anchorbrowser.io/blog/article-1');

    expect(fetcher.mock.calls[3]?.[1]?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(bodyOf(fetcher, 3))).toEqual({
      session_id: 'publish-session',
      sync: true,
      cleanup_sessions: false,
      input_params: {
        ticket_url: 'https://app.withgauge.com/ticket-1',
        destination: 'blogs',
        author: 'Idan Raman',
        thumbnail_file: 'data:image/png;name=thumb%20nail.png;filename=thumb%20nail.png;base64,AQID',
        thumbnail_file_original_filename: 'thumb nail.png',
      },
    });
  });

  it('surfaces task run failures and always closes the session', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-5' } }))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'task-5', name: 'anchor-identity-monitor-gauge-dom-check', description: generatedDescription(authCheck(gaugeTarget)), latestVersion: '1', aiFallbackEnabled: false }] }),
      )
      .mockResolvedValueOnce(response({ status: 'failed', error: 'Browser crashed' }))
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.runTask(authCheck(gaugeTarget), run)).rejects.toThrow('Browser crashed');
    expect(fetcher.mock.calls[3]?.[0]).toBe('https://api.anchorbrowser.io/v1/sessions/session-5');
  });

  it('preserves HTTP status on API errors and rejects malformed responses', async () => {
    const failing = new HttpAnchorClient(config, vi.fn<typeof fetch>().mockImplementation(async () => response({ error: 'expired' }, 422)));
    const error = await failing.listIdentities('app-1').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AnchorApiError);
    expect(error).toMatchObject({ status: 422, method: 'GET' });

    const malformed = new HttpAnchorClient(config, vi.fn<typeof fetch>().mockResolvedValue(response({ identities: {} })));
    await expect(malformed.listIdentities('app-1')).rejects.toThrow('invalid identities response');
  });
});
