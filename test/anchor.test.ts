import { describe, expect, it, vi } from 'vitest';
import { AnchorApiError, HttpAnchorClient } from '../src/anchor.js';
import { authCheck, gaugeFindArticle, gaugePublishArticle } from '../src/tasks.js';
import { testConfig } from './fakes.js';

const config = testConfig();
const gaugeTarget = config.targets[0]!;
const run = { applicationId: 'app-1', identityId: 'identity-1' };

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

  it('reuses an existing ready task without regenerating it', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-2' } }))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'task-existing', name: 'anchor-identity-monitor-gauge-dom-check', latestVersion: 'latest', aiFallbackEnabled: false }] }),
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
        response({ tasks: [{ id: 'task-existing', name: 'anchor-identity-monitor-gauge-dom-check', latestVersion: 'latest', aiFallbackEnabled: true }] }),
      )
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ status: 'success', result: { authenticated: true } }))
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await client.runTask(authCheck(gaugeTarget), run);

    expect(fetcher.mock.calls[2]?.[0]).toBe('https://api.anchorbrowser.io/v1/task/task-existing');
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ method: 'PUT', body: JSON.stringify({ ai_fallback_enabled: false }) });
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

  it('sends file inputs as multipart with input_params as a JSON string', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'publish-session' } }))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'publish-task', name: 'gauge-publish-article-from-todo', latestVersion: '1', aiFallbackEnabled: true }] }),
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
        file: { fileName: 'thumbnail.png', mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) },
      }),
    ).resolves.toBe('https://anchorbrowser.io/blog/article-1');

    const form = fetcher.mock.calls[2]?.[1]?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    expect(JSON.parse(String(form.get('input_params')))).toEqual({
      ticket_url: 'https://app.withgauge.com/ticket-1',
      destination: 'blogs',
      author: 'Idan Raman',
    });
    expect(form.get('session_id')).toBe('publish-session');
    expect(form.get('identity_skip_validation')).toBe('true');
    expect(form.get('thumbnail_file')).toMatchObject({ name: 'thumbnail.png', type: 'image/png' });
  });

  it('surfaces task run failures and always closes the session', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-5' } }))
      .mockResolvedValueOnce(
        response({ tasks: [{ id: 'task-5', name: 'anchor-identity-monitor-gauge-dom-check', latestVersion: '1', aiFallbackEnabled: false }] }),
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
