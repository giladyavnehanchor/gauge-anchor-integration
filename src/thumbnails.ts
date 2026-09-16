import { readFile } from 'node:fs/promises';
import type { Config, Log, ThumbnailClient, ThumbnailOption } from './types.js';

interface GeneratedImage {
  data?: string;
  mimeType?: string;
  url?: string;
}

const THUMBNAIL_STYLES = [
  {
    title: 'Editorial hero',
    direction: 'A polished editorial hero image with one clear focal subject and generous negative space for the title',
  },
  {
    title: 'Conceptual visual',
    direction: 'A distinctive conceptual composition that visually represents the article idea',
  },
  {
    title: 'Human-centered scene',
    direction: 'A natural, human-centered scene that makes the topic approachable and emotionally engaging',
  },
  {
    title: 'Technical illustration',
    direction: 'A soft, sketched illustration of the core mechanism or workflow behind the article topic, drawn as one scene rather than icons or a diagram',
  },
  {
    title: 'Minimalist abstract',
    direction: 'A bold minimalist abstract image built around one focused visual metaphor',
  },
];

/** The site renders thumbnails at 1920x1080; providers that reject it get the closest size they accept. */
const IMAGE_SIZES = ['1920x1080', '1536x1024'];
const TITLE_WORDS = { min: 3, max: 6 };

function imagePrompt(articleTitle: string, articleSummary: string, titleText: string, direction: string): string {
  return `Create a 16:9 article thumbnail in the exact visual style of the attached reference image: match its
composition, grainy texture, soft lighting, typography and overall feel, rendered strictly in black and white.

Article title: ${articleTitle}
Article summary: ${articleSummary}

Visual direction: ${direction}

Requirements:
- Black and white only: pure grayscale, no color anywhere.
- Include this title text exactly once, spelled exactly as written, in a clean bold sans-serif like the
  reference: "${titleText}"
- Place the title left-aligned in the left half on one to three lines, fully inside the frame with a
  clear margin from the edge; keep the illustration in the right half.
- No other text anywhere: no labels, captions, or names on objects, no watermarks, logos, or UI screenshots.
- No birds. No flat icons, clip art, or diagrams; keep the grainy illustrated look of the reference.
- Represent the article content accurately, without inventing specific facts.
- Output only the image.`;
}

function titlePrompt(articleTitle: string, articleSummary: string): string {
  return `Write the title text for an article thumbnail image.

Article title: ${articleTitle}
Article summary: ${articleSummary}

Rules:
- ${TITLE_WORDS.min} to ${TITLE_WORDS.max} words.
- Plain words in Title Case. No quotes and no trailing punctuation; "vs" is fine.
- Prefer short, common words; keep the whole title under 30 characters so it renders cleanly.
- Capture the article's core idea rather than repeating the full title.
Return only the title text.`;
}

function titleFrom(text: string, articleTitle: string): string {
  const words = text.trim().replace(/^["'“”]+|["'“”.!?]+$/g, '').split(/\s+/).filter(Boolean);
  if (words.length >= TITLE_WORDS.min && words.length <= TITLE_WORDS.max) return words.join(' ');
  const clause = articleTitle.split(/[:|–—]| - /)[0] ?? articleTitle;
  return clause.trim().split(/\s+/).slice(0, TITLE_WORDS.max).join(' ');
}

function generatedImage(value: unknown): GeneratedImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Image provider returned an invalid image response');
  }
  const image = value as Record<string, unknown>;
  const data = typeof image.b64_json === 'string' ? image.b64_json : undefined;
  const url = typeof image.url === 'string' ? image.url : undefined;
  if (!data && !url) throw new Error('Image provider returned no image data');
  return {
    ...(data ? { data } : {}),
    ...(url ? { url } : {}),
    ...(typeof image.mime_type === 'string' ? { mimeType: image.mime_type } : {}),
  };
}

class ProviderError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function rejectedSize(error: unknown): boolean {
  return error instanceof ProviderError && error.status === 400 && /size/i.test(error.message);
}

export class HttpThumbnailClient implements ThumbnailClient {
  private acceptedSize: string | undefined;

  constructor(
    private readonly config: Pick<
      Config,
      'thumbnailProvider' | 'thumbnailModel' | 'thumbnailReferenceImage' | 'openaiApiKey' | 'geminiApiKey' | 'requestTimeoutMs'
    > & { thumbnailTimeoutMs?: number },
    private readonly fetcher: typeof fetch = fetch,
    private readonly saveImage?: (fileName: string, data: string, mimeType: string) => Promise<string>,
    private readonly logger: Log = (message, details) => console.log(message, details ?? ''),
    private readonly readBytes: (path: string) => Promise<Uint8Array> = async (path) => new Uint8Array(await readFile(path)),
  ) {}

  async generate(articleTitle: string, articleSummary: string): Promise<ThumbnailOption[]> {
    const provider = this.config.thumbnailProvider;
    if (!provider) {
      throw new Error('No thumbnail AI credentials configured; set OPENAI_API_KEY or GEMINI_API_KEY');
    }

    const startedAt = Date.now();
    this.logger('Thumbnail generation started', {
      provider,
      model: this.config.thumbnailModel ?? 'provider default',
      reference: this.config.thumbnailReferenceImage,
      optionCount: THUMBNAIL_STYLES.length,
      timeoutMs: this.config.thumbnailTimeoutMs ?? this.config.requestTimeoutMs,
    });
    try {
      const reference = await this.readBytes(this.config.thumbnailReferenceImage);
      const titleText = await this.titleText(articleTitle, articleSummary);
      const option = (style: (typeof THUMBNAIL_STYLES)[number], index: number) => this.generateOption(style, index, {
        prompt: imagePrompt(articleTitle, articleSummary, titleText, style.direction),
        titleText,
        reference,
      });
      // The first option settles which image size the provider accepts; the rest reuse it in parallel.
      const [first, ...styles] = THUMBNAIL_STYLES as [typeof THUMBNAIL_STYLES[number], ...typeof THUMBNAIL_STYLES];
      const thumbnails = [
        await option(first, 0),
        ...(await Promise.all(styles.map((style, index) => option(style, index + 1)))),
      ];
      this.logger('Thumbnail generation completed', {
        provider,
        optionCount: thumbnails.length,
        durationMs: Date.now() - startedAt,
      });
      return thumbnails;
    } catch (error) {
      this.logger('Thumbnail generation failed', {
        provider,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async generateOption(
    style: { title: string; direction: string },
    index: number,
    input: { prompt: string; titleText: string; reference: Uint8Array },
  ): Promise<ThumbnailOption> {
    const optionStartedAt = Date.now();
    this.logger('Thumbnail option started', { option: index + 1, title: style.title });
    const image = this.config.thumbnailProvider === 'openai'
      ? await this.generateOpenAi(input.prompt, input.reference)
      : await this.generateGemini(input.prompt, input.reference);
    const filePath = image.data
      ? await this.persistImage(image.data, image.mimeType ?? 'image/png', index)
      : undefined;
    this.logger('Thumbnail option completed', {
      option: index + 1,
      title: style.title,
      durationMs: Date.now() - optionStartedAt,
      output: filePath ?? image.url ?? 'generated image',
    });
    return {
      title: style.title,
      titleText: input.titleText,
      prompt: input.prompt,
      ...(image.url ? { imageUrl: image.url } : {}),
      ...(filePath ? { filePath } : {}),
      ...(image.mimeType ? { mimeType: image.mimeType } : {}),
    };
  }

  private async titleText(articleTitle: string, articleSummary: string): Promise<string> {
    const prompt = titlePrompt(articleTitle, articleSummary);
    const text = this.config.thumbnailProvider === 'openai'
      ? await this.completeOpenAi(prompt)
      : await this.completeGemini(prompt);
    const titleText = titleFrom(text, articleTitle);
    this.logger('Thumbnail title chosen', { titleText, suggested: text.trim() });
    return titleText;
  }

  private async completeOpenAi(prompt: string): Promise<string> {
    const payload = await this.request(
      'https://api.openai.com/v1/chat/completions',
      { model: 'gpt-4.1-mini', messages: [{ role: 'user', content: prompt }], max_tokens: 40 },
      { authorization: `Bearer ${this.openaiKey()}` },
    );
    const body = this.record(payload, 'OpenAI completion response');
    const choice = Array.isArray(body.choices) ? this.record(body.choices[0], 'OpenAI choice') : undefined;
    const message = choice ? this.record(choice.message, 'OpenAI message') : undefined;
    if (typeof message?.content !== 'string') throw new Error('OpenAI completion returned no text');
    return message.content;
  }

  private async completeGemini(prompt: string): Promise<string> {
    const payload = await this.request(this.geminiUrl('gemini-2.0-flash'), {
      contents: [{ parts: [{ text: prompt }] }],
    });
    for (const part of this.geminiParts(payload)) {
      if (typeof part.text === 'string' && part.text.trim()) return part.text;
    }
    throw new Error('Gemini completion returned no text');
  }

  /** The reference image goes to the edits endpoint, which restyles it instead of drawing from scratch. */
  private async generateOpenAi(prompt: string, reference: Uint8Array): Promise<GeneratedImage> {
    const sizes = this.acceptedSize ? [this.acceptedSize] : IMAGE_SIZES;
    for (const [attempt, size] of sizes.entries()) {
      const form = new FormData();
      form.append('model', this.config.thumbnailModel ?? 'gpt-image-1');
      form.append('prompt', prompt);
      form.append('size', size);
      form.append('quality', 'medium');
      form.append('n', '1');
      form.append('image', new Blob([reference as BlobPart], { type: 'image/png' }), 'reference.png');
      try {
        const payload = await this.request('https://api.openai.com/v1/images/edits', form, {
          authorization: `Bearer ${this.openaiKey()}`,
        });
        this.acceptedSize = size;
        const body = this.record(payload, 'OpenAI image response');
        if (!Array.isArray(body.data) || body.data.length === 0) {
          throw new Error('OpenAI image response contained no images');
        }
        return generatedImage(body.data[0]);
      } catch (error) {
        const next = sizes[attempt + 1];
        if (!next || !rejectedSize(error)) throw error;
        this.logger('Thumbnail size rejected, retrying', { rejected: size, next });
      }
    }
    throw new Error('OpenAI rejected every thumbnail size');
  }

  private async generateGemini(prompt: string, reference: Uint8Array): Promise<GeneratedImage> {
    const model = this.config.thumbnailModel ?? 'gemini-2.5-flash-image';
    const payload = await this.request(this.geminiUrl(model), {
      contents: [{
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'image/png', data: Buffer.from(reference).toString('base64') } },
        ],
      }],
      generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: '16:9' } },
    });
    for (const part of this.geminiParts(payload)) {
      const inlineData = part.inlineData ?? part.inline_data;
      if (!inlineData || typeof inlineData !== 'object') continue;
      const { data, mimeType } = inlineData as Record<string, unknown>;
      if (typeof data === 'string' && data) {
        return { data, mimeType: typeof mimeType === 'string' ? mimeType : 'image/png' };
      }
    }
    throw new Error('Gemini image response contained no inline image');
  }

  private geminiUrl(model: string): string {
    const apiKey = this.config.geminiApiKey;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  }

  private geminiParts(payload: unknown): Record<string, unknown>[] {
    const body = this.record(payload, 'Gemini response');
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    return candidates.flatMap((candidate) => {
      const content = candidate && typeof candidate === 'object' ? (candidate as Record<string, unknown>).content : undefined;
      const parts = content && typeof content === 'object' ? (content as Record<string, unknown>).parts : undefined;
      return Array.isArray(parts) ? parts.filter((part): part is Record<string, unknown> => !!part && typeof part === 'object') : [];
    });
  }

  private openaiKey(): string {
    if (!this.config.openaiApiKey) throw new Error('OPENAI_API_KEY is not configured');
    return this.config.openaiApiKey;
  }

  private async persistImage(data: string, mimeType: string, index: number): Promise<string | undefined> {
    if (!this.saveImage) return undefined;
    const extension = mimeType.includes('jpeg') ? 'jpg' : 'png';
    return this.saveImage(`${Date.now()}-thumbnail-${index + 1}.${extension}`, data, mimeType);
  }

  private async request(url: string, body: FormData | object, extraHeaders: Record<string, string> = {}): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = this.config.thumbnailTimeoutMs ?? this.config.requestTimeoutMs;
    const endpoint = this.safeEndpoint(url);
    const isForm = body instanceof FormData;
    this.logger('Thumbnail provider request started', { endpoint, timeoutMs });
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          ...(isForm ? {} : { 'content-type': 'application/json' }),
          ...extraHeaders,
        },
        body: isForm ? body : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        this.logger('Thumbnail provider request failed', { endpoint, status: response.status, response: text.slice(0, 300) });
        throw new ProviderError(`Thumbnail provider failed with HTTP ${response.status}: ${text.slice(0, 300)}`, response.status);
      }
      this.logger('Thumbnail provider request completed', { endpoint, status: response.status });
      return text ? JSON.parse(text) as unknown : {};
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger('Thumbnail provider request timed out', { endpoint, timeoutMs });
        throw new Error(`Thumbnail provider request timed out after ${timeoutMs}ms (${endpoint})`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private record(value: unknown, context: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Thumbnail provider returned an invalid ${context}`);
    }
    return value as Record<string, unknown>;
  }

  private safeEndpoint(url: string): string {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  }
}
