import { describe, expect, it, vi } from 'vitest';
import { HttpThumbnailClient } from '../src/thumbnails.js';

const config = {
  thumbnailProvider: 'openai' as const,
  thumbnailModel: 'gpt-image-1',
  thumbnailReferenceImage: '/assets/reference.png',
  openaiApiKey: 'openai-key',
  requestTimeoutMs: 1000,
};

const reference = new Uint8Array([137, 80, 78, 71]);
const readBytes = vi.fn().mockResolvedValue(reference);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Answers the title completion and the image edits; rejects 1920x1080 the way OpenAI does. */
function openAiFetcher(titleText = 'Headless vs Headful Browsers') {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).endsWith('/chat/completions')) {
      return json({ choices: [{ message: { content: `"${titleText}."` } }] });
    }
    const form = init?.body as FormData;
    if (form.get('size') === '1920x1080') {
      return json({ error: { message: "Invalid value: '1920x1080'. Supported values are: '1024x1024', '1536x1024', '1024x1536', and 'auto'.", param: 'size' } }, 400);
    }
    return json({ data: [{ b64_json: 'aW1hZ2U=', mime_type: 'image/png' }] });
  });
}

describe('HttpThumbnailClient', () => {
  it('restyles the reference image into five black-and-white options with one short title', async () => {
    const fetcher = openAiFetcher();
    const saveImage = vi.fn().mockImplementation(async (fileName: string) => `/tmp/${fileName}`);
    const client = new HttpThumbnailClient(config, fetcher, saveImage, () => undefined, readBytes);

    const result = await client.generate('Anchorbrowser vs. Browserbase: The Reliable AI Web Browser', 'Article summary');

    expect(readBytes).toHaveBeenCalledWith('/assets/reference.png');
    expect(result).toHaveLength(5);
    expect(result[0]?.filePath).toMatch(/^\/tmp\/.*thumbnail-1\.png$/);
    expect(result.every((option) => option.titleText === 'Headless vs Headful Browsers')).toBe(true);
    expect(result[0]?.prompt).toContain('"Headless vs Headful Browsers"');
    expect(result[0]?.prompt).toContain('Black and white only');
    expect(result[0]?.prompt).toContain('No birds');
    expect(saveImage).toHaveBeenCalledTimes(5);

    const urls = fetcher.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toBe('https://api.openai.com/v1/chat/completions');
    expect(urls.filter((url) => url.endsWith('/images/edits'))).toHaveLength(6);
  });

  it('tries 1920x1080 once and sticks with 1536x1024 after it is rejected', async () => {
    const fetcher = openAiFetcher();
    const client = new HttpThumbnailClient(config, fetcher, undefined, () => undefined, readBytes);

    await client.generate('Title', 'Summary');

    const edits = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/images/edits'));
    const sizes = edits.map(([, init]) => (init?.body as FormData).get('size'));
    expect(sizes).toEqual(['1920x1080', '1536x1024', '1536x1024', '1536x1024', '1536x1024', '1536x1024']);

    const form = edits[1]?.[1]?.body as FormData;
    const image = form.get('image') as File;
    expect(form.get('model')).toBe('gpt-image-1');
    expect(image.name).toBe('reference.png');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(reference);
    expect(edits[1]?.[1]?.headers).not.toHaveProperty('content-type');
  });

  it('falls back to the article title when the suggested title has the wrong length', async () => {
    const fetcher = openAiFetcher('Way too many words for a thumbnail title text');
    const client = new HttpThumbnailClient(config, fetcher, undefined, () => undefined, readBytes);

    const [option] = await client.generate('Headless Browsers Explained: A Complete Guide', 'Summary');

    expect(option?.titleText).toBe('Headless Browsers Explained');
  });

  it('sends the reference inline to Gemini with a 16:9 aspect ratio', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
      const body = JSON.parse(String(init?.body)) as { generationConfig?: unknown };
      if (!body.generationConfig) return json({ candidates: [{ content: { parts: [{ text: 'Browsers Without Heads' }] } }] });
      return json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] } }] });
    });
    const { thumbnailModel: _model, ...base } = config;
    const client = new HttpThumbnailClient(
      { ...base, thumbnailProvider: 'gemini', geminiApiKey: 'gemini-key' },
      fetcher,
      undefined,
      () => undefined,
      readBytes,
    );

    const result = await client.generate('Title', 'Summary');

    expect(result).toHaveLength(5);
    expect(result[0]?.titleText).toBe('Browsers Without Heads');
    const imageCall = fetcher.mock.calls[1];
    expect(String(imageCall?.[0])).toContain('gemini-2.5-flash-image');
    const body = JSON.parse(String(imageCall?.[1]?.body));
    expect(body.contents[0].parts[1].inlineData).toEqual({ mimeType: 'image/png', data: Buffer.from(reference).toString('base64') });
    expect(body.generationConfig.imageConfig).toEqual({ aspectRatio: '16:9' });
  });

  it('fails clearly when no image provider is configured', async () => {
    const client = new HttpThumbnailClient(
      { requestTimeoutMs: 1000, thumbnailReferenceImage: '/assets/reference.png' },
      vi.fn<typeof fetch>(),
      undefined,
      () => undefined,
      readBytes,
    );

    await expect(client.generate('Title', 'Summary')).rejects.toThrow('set OPENAI_API_KEY or GEMINI_API_KEY');
  });
});
