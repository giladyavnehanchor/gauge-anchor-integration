import { describe, expect, it, vi } from 'vitest';
import { HttpThumbnailClient } from '../src/thumbnails.js';

const config = {
  thumbnailProvider: 'openai' as const,
  thumbnailModel: 'gpt-image-1',
  openaiApiKey: 'openai-key',
  requestTimeoutMs: 1000,
};

describe('HttpThumbnailClient', () => {
  it('creates and persists five OpenAI thumbnail options', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=', mime_type: 'image/png' }] }), { status: 200 }),
    );
    const saveImage = vi.fn().mockImplementation(async (fileName: string) => `/tmp/${fileName}`);
    const client = new HttpThumbnailClient(config, fetcher, saveImage, () => undefined);

    const result = await client.generate('Article title', 'Article summary');

    expect(result).toHaveLength(5);
    expect(result[0]?.filePath).toMatch(/^\/tmp\/.*thumbnail-1\.png$/);
    expect(saveImage).toHaveBeenCalledTimes(5);
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('fails clearly when no image provider is configured', async () => {
    const client = new HttpThumbnailClient({ requestTimeoutMs: 1000 }, vi.fn<typeof fetch>(), undefined, () => undefined);

    await expect(client.generate('Title', 'Summary')).rejects.toThrow('set OPENAI_API_KEY or GEMINI_API_KEY');
  });
});
