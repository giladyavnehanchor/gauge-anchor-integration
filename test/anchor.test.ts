import { describe, expect, it, vi } from 'vitest';
import { HttpAnchorClient } from '../src/anchor.js';
import type { AnchorApiError } from '../src/anchor.js';

const config = {
  anchorApiBase: 'https://api.anchorbrowser.io/v1',
  anchorApiKey: 'secret',
  requestTimeoutMs: 1000,
  reauthTimeoutMs: 900000,
  taskPollIntervalMs: 1,
  contentTaskTimeoutMs: 900000,
  gaugeContentTaskName: 'gauge-content-research-outline',
} as const;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HttpAnchorClient', () => {
  it('uses the documented API key header and parses applications', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        applications: [
          {
            id: 'app-1',
            name: 'Gauge',
            url: 'https://gauge.example.com',
            identity_count: 1,
          },
        ],
      }),
    );
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.listApplications('Gauge')).resolves.toEqual([
      {
        id: 'app-1',
        name: 'Gauge',
        url: 'https://gauge.example.com',
        identityCount: 1,
      },
    ]);
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.anchorbrowser.io/v1/applications?search=Gauge',
      expect.objectContaining({
        headers: expect.objectContaining({ 'anchor-api-key': 'secret' }),
      }),
    );
  });

  it('parses identity and link responses', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          identities: [
            { id: 'identity-1', name: 'Account', status: 'validated', updated_at: '2030-01-01' },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({ identity_url: 'https://anchor.test/create', expires_at: '2030-01-02' }),
      )
      .mockResolvedValueOnce(response({ identityId: 'identity-1', async: false }))
      .mockResolvedValueOnce(
        response({ reauth_url: 'https://anchor.test/reauth', expires_at: '2030-01-03' }),
      );
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.listIdentities('app-1')).resolves.toEqual([
      {
        id: 'identity-1',
        name: 'Account',
        status: 'validated',
        updatedAt: '2030-01-01',
      },
    ]);
    await expect(client.createIdentityLink('app-1', 'Owner')).resolves.toEqual({
      url: 'https://anchor.test/create',
      expiresAt: '2030-01-02',
    });
    await expect(client.reauthenticate('identity-1')).resolves.toEqual({
      identityId: 'identity-1',
      async: false,
    });
    await expect(client.createReauthLink('identity-1', 'profile')).resolves.toEqual({
      url: 'https://anchor.test/reauth',
      expiresAt: '2030-01-03',
    });
  });

  it('creates an application from a source URL', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      response({
        id: 'app-2',
        name: 'Gauge',
        url: 'app.withgauge.com',
        identity_count: 0,
      }),
    );
    const client = new HttpAnchorClient(config, fetcher);

    await expect(
      client.createApplication('https://app.withgauge.com', 'Gauge'),
    ).resolves.toEqual({
      id: 'app-2',
      name: 'Gauge',
      url: 'app.withgauge.com',
      identityCount: 0,
    });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.anchorbrowser.io/v1/applications',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ source: 'https://app.withgauge.com', name: 'Gauge' }),
      }),
    );
  });

  it('creates and runs a deterministic DOM task inside an identity session', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-1' } }))
      .mockResolvedValueOnce(response({ tasks: [] }))
      .mockResolvedValueOnce(response({ id: 'task-1', status: 'generating' }))
      .mockResolvedValueOnce(response({ id: 'task-1', status: 'ready' }))
      .mockResolvedValueOnce(
        response({
          status: 'success',
          result: { success: false, output: { authenticated: true } },
        }),
      )
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(
      client.validateIdentity(
        'identity-1',
        'app.withgauge.com',
        'application-1',
        'anchor-identity-monitor-gauge-dom-check',
      ),
    ).resolves.toBe(true);
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.anchorbrowser.io/v1/task?name=anchor-identity-monitor-gauge-dom-check&limit=100',
      expect.objectContaining({
        method: 'GET',
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'https://api.anchorbrowser.io/v2/tasks/generate',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"ai_fallback_enabled":false'),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      3,
      'https://api.anchorbrowser.io/v2/tasks/generate',
      expect.objectContaining({
        body: expect.stringContaining('Triage'),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      'https://api.anchorbrowser.io/v2/tasks/task-1/run',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"session_id":"session-1"'),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      6,
      'https://api.anchorbrowser.io/v1/sessions/session-1',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('retries a transient task-generation 404', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-3' } }))
      .mockResolvedValueOnce(response({ tasks: [] }))
      .mockResolvedValueOnce(response({ id: 'task-3', status: 'generating' }))
      .mockResolvedValueOnce(response({ error: 'Task not found' }, 404))
      .mockResolvedValueOnce(
        response({
          tasks: [
            {
              id: 'task-3',
              name: 'anchor-identity-monitor-gauge-dom-check',
              latestVersion: 'draft',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(response({ status: 'ready' }))
      .mockResolvedValueOnce(
        response({
          status: 'success',
          result: { success: false, output: { authenticated: true } },
        }),
      )
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(
      client.validateIdentity(
        'identity-1',
        'app.withgauge.com',
        'application-1',
        'anchor-identity-monitor-gauge-dom-check',
      ),
    ).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(8);
  });

  it('reuses an existing canonical validation task', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'session-2' } }))
      .mockResolvedValueOnce(
        response({
          tasks: [
            {
              id: 'task-existing',
              name: 'anchor-identity-monitor-gauge-dom-check',
              latestVersion: 'latest',
              aiFallbackEnabled: false,
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({ status: 'success', result: { authenticated: false } }),
      )
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(
      client.validateIdentity(
        'identity-1',
        'app.withgauge.com',
        'application-1',
        'anchor-identity-monitor-gauge-dom-check',
      ),
    ).resolves.toBe(false);

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher).not.toHaveBeenCalledWith(
      'https://api.anchorbrowser.io/v2/tasks/generate',
      expect.anything(),
    );
  });

  it('runs the existing Gauge content task and rejects published output', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          tasks: [
            {
              id: 'content-task-1',
              name: 'gauge-content-research-outline',
              latestVersion: '1',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        response({
          status: 'success',
          result: {
            ticket_url: 'https://app.withgauge.com/tasks/ticket-1',
            article_title: 'A Gauge article',
            article_summary: 'A concise article summary',
            research_completed: true,
            outline_completed: true,
            published: false,
            message: 'Stopped before publishing',
          },
        }),
      );
    const client = new HttpAnchorClient(config, fetcher);

    await expect(
      client.runGaugeContentTask(
        'application-1',
        'identity-1',
        'gauge-content-research-outline',
      ),
    ).resolves.toEqual({
      ticketUrl: 'https://app.withgauge.com/tasks/ticket-1',
      articleTitle: 'A Gauge article',
      articleSummary: 'A concise article summary',
      researchCompleted: true,
      outlineCompleted: true,
      published: false,
      message: 'Stopped before publishing',
    });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.anchorbrowser.io/v2/tasks/content-task-1/run',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"identity_id":"identity-1"'),
      }),
    );
  });

  it('creates the Gauge content task when it is missing', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ tasks: [] }))
      .mockResolvedValueOnce(response({ taskId: 'content-task-2' }))
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
      );
    const client = new HttpAnchorClient(config, fetcher);

    await expect(
      client.runGaugeContentTask(
        'application-1',
        'identity-1',
        'gauge-content-research-outline',
      ),
    ).resolves.toMatchObject({ articleTitle: 'Generated article' });
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.anchorbrowser.io/v2/tasks/generate',
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"article_title"'),
      }),
    );
    expect(fetcher).toHaveBeenNthCalledWith(
      2,
      'https://api.anchorbrowser.io/v2/tasks/generate',
      expect.objectContaining({
        body: expect.stringContaining('Completed, Done, Published'),
      }),
    );
  });

  it('uploads the chosen thumbnail and publishes a Gauge Todo article', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response({ data: { id: 'publish-session' } }))
      .mockResolvedValueOnce(response({ tasks: [] }))
      .mockResolvedValueOnce(response({ id: 'publish-task', status: 'generating' }))
      .mockResolvedValueOnce(response({ status: 'ready' }))
      .mockResolvedValueOnce(
        response({
          status: 'success',
          result: {
            article_url: 'https://app.withgauge.com/article-1',
            published: true,
            message: 'Published',
          },
        }),
      )
      .mockResolvedValueOnce(response({}));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(
      client.publishGaugeArticle(
        'application-1',
        'identity-1',
        'gauge-publish-article-from-todo',
        {
          draftId: 'draft-1',
          ticketUrl: 'https://app.withgauge.com/ticket-1',
          articleTitle: 'Article',
          articleSummary: 'Summary',
          thumbnailPath: '/tmp/thumbnail.png',
          destination: 'blogs',
        },
        {
          fileName: 'thumbnail.png',
          mimeType: 'image/png',
          data: new Uint8Array([1, 2, 3]),
        },
      ),
    ).resolves.toBe('https://app.withgauge.com/article-1');
    expect(fetcher).toHaveBeenNthCalledWith(
      5,
      'https://api.anchorbrowser.io/v2/tasks/publish-task/run',
      expect.objectContaining({
        body: expect.any(FormData),
      }),
    );
    const runOptions = fetcher.mock.calls[4]?.[1];
    const runForm = runOptions?.body as FormData;
    expect(JSON.parse(String(runForm.get('input_params')))).toEqual({
      ticket_url: 'https://app.withgauge.com/ticket-1',
      article_title: 'Article',
      article_summary: 'Summary',
      destination: 'blogs',
      author: 'Idan Raman',
    });
    expect(runForm.get('session_id')).toBe('publish-session');
    expect(runForm.get('thumbnail_file')).toMatchObject({
      name: 'thumbnail.png',
      type: 'image/png',
    });
  });

  it('preserves validation status for stale identity handling', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error: 'expired' }, 422));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.reauthenticate('identity-1')).rejects.toMatchObject({
      status: 422,
      method: 'POST',
    } satisfies Partial<AnchorApiError>);
  });

  it('rejects malformed responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ identities: {} }));
    const client = new HttpAnchorClient(config, fetcher);

    await expect(client.listIdentities('app-1')).rejects.toThrow('invalid identities response');
  });
});
