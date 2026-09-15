import type {
  MonitorConfig,
  ThumbnailClient,
  ThumbnailOption,
} from './types.js';

interface GeneratedImage {
  data?: string;
  mimeType?: string;
  url?: string;
}

const THUMBNAIL_STYLES = [
  {
    title: 'Editorial hero',
    direction: 'A polished editorial hero image with one clear focal subject and generous negative space for headline text',
  },
  {
    title: 'Conceptual visual',
    direction: 'A distinctive conceptual composition that visually represents the article idea without using text or logos',
  },
  {
    title: 'Human-centered scene',
    direction: 'A natural, human-centered scene that makes the topic approachable and emotionally engaging',
  },
  {
    title: 'Technical illustration',
    direction: 'A clean technical illustration showing the core mechanism or workflow behind the article topic',
  },
  {
    title: 'Minimalist abstract',
    direction: 'A bold minimalist abstract image using a focused visual metaphor and a restrained editorial color palette',
  },
];

function imagePrompt(
  articleTitle: string,
  articleSummary: string,
  direction: string,
): string {
  return `Create a high-quality 16:9 article thumbnail for the following content.

Article title: ${articleTitle}
Article summary: ${articleSummary}

Visual direction: ${direction}

Requirements:
- No text, lettering, watermarks, logos, or UI screenshots.
- Use a professional editorial style and strong contrast at small sizes.
- Represent the article content accurately, without inventing specific facts.
- Output only the image.`;
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

export class HttpThumbnailClient implements ThumbnailClient {
  constructor(
    private readonly config: Pick<
      MonitorConfig,
      | 'thumbnailProvider'
      | 'thumbnailModel'
      | 'thumbnailOutputDir'
      | 'openaiApiKey'
      | 'geminiApiKey'
      | 'anthropicApiKey'
      | 'requestTimeoutMs'
      | 'thumbnailTimeoutMs'
    >,
    private readonly fetcher: typeof fetch = fetch,
    private readonly saveImage?: (
      fileName: string,
      data: string,
      mimeType: string,
    ) => Promise<string>,
    private readonly logger: (
      message: string,
      details?: Record<string, unknown>,
    ) => void = (message, details) => console.log(message, details ?? ''),
  ) {}

  async generate(articleTitle: string, articleSummary: string): Promise<ThumbnailOption[]> {
    const provider = this.config.thumbnailProvider;
    if (!provider) {
      throw new Error(
        'No thumbnail AI credentials configured; set OPENAI_API_KEY or GEMINI_API_KEY',
      );
    }
    if (provider === 'anthropic') {
      throw new Error(
        'Anthropic Claude does not provide image generation; configure OPENAI_API_KEY or GEMINI_API_KEY for thumbnails',
      );
    }

    const startedAt = Date.now();
    this.logger('Thumbnail generation started', {
      provider,
      model: this.config.thumbnailModel ?? 'provider default',
      optionCount: THUMBNAIL_STYLES.length,
      timeoutMs: this.config.thumbnailTimeoutMs ?? this.config.requestTimeoutMs,
    });
    return Promise.all(
      THUMBNAIL_STYLES.map(async (style, index) => {
        const optionStartedAt = Date.now();
        this.logger('Thumbnail option started', {
          provider,
          option: index + 1,
          title: style.title,
        });
        const prompt = imagePrompt(articleTitle, articleSummary, style.direction);
        const image =
          provider === 'openai'
            ? await this.generateOpenAi(prompt)
            : await this.generateGemini(prompt);
        const filePath = image.data
          ? await this.persistImage(image.data, image.mimeType ?? 'image/png', index)
          : undefined;
        const thumbnail = {
          title: style.title,
          prompt,
          ...(image.url ? { imageUrl: image.url } : {}),
          ...(filePath ? { filePath } : {}),
          ...(image.mimeType ? { mimeType: image.mimeType } : {}),
        };
        this.logger('Thumbnail option completed', {
          provider,
          option: index + 1,
          title: style.title,
          durationMs: Date.now() - optionStartedAt,
          output: filePath ?? image.url ?? 'generated image',
        });
        return thumbnail;
      }),
    ).then((thumbnails) => {
      this.logger('Thumbnail generation completed', {
        provider,
        optionCount: thumbnails.length,
        durationMs: Date.now() - startedAt,
      });
      return thumbnails;
    }).catch((error) => {
      this.logger('Thumbnail generation failed', {
        provider,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    });
  }

  private async generateOpenAi(prompt: string): Promise<GeneratedImage> {
    const apiKey = this.config.openaiApiKey;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not configured');
    const payload = await this.requestJson(
      'https://api.openai.com/v1/images/generations',
      {
        model: this.config.thumbnailModel ?? 'gpt-image-1',
        prompt,
        size: '1536x1024',
        quality: 'medium',
        n: 1,
      },
      {
        authorization: `Bearer ${apiKey}`,
      },
    );
    const body = this.record(payload, 'OpenAI image response');
    if (!Array.isArray(body.data) || body.data.length === 0) {
      throw new Error('OpenAI image response contained no images');
    }
    return generatedImage(body.data[0]);
  }

  private async generateGemini(prompt: string): Promise<GeneratedImage> {
    const apiKey = this.config.geminiApiKey;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');
    const model = this.config.thumbnailModel ?? 'gemini-2.0-flash-exp-image-generation';
    const payload = await this.requestJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      },
    );
    const body = this.record(payload, 'Gemini image response');
    const candidates = Array.isArray(body.candidates) ? body.candidates : [];
    for (const candidate of candidates) {
      if (!candidate || typeof candidate !== 'object') continue;
      const content = (candidate as Record<string, unknown>).content;
      if (!content || typeof content !== 'object') continue;
      const parts = (content as Record<string, unknown>).parts;
      if (!Array.isArray(parts)) continue;
      for (const part of parts) {
        if (!part || typeof part !== 'object') continue;
        const inlineData =
          (part as Record<string, unknown>).inlineData ??
          (part as Record<string, unknown>).inline_data;
        if (!inlineData || typeof inlineData !== 'object') continue;
        const data = (inlineData as Record<string, unknown>).data;
        if (typeof data !== 'string' || !data) continue;
        const mimeType =
          typeof (inlineData as Record<string, unknown>).mimeType === 'string'
            ? (inlineData as Record<string, unknown>).mimeType as string
            : 'image/png';
        return { data, mimeType };
      }
    }
    throw new Error('Gemini image response contained no inline image');
  }

  private async persistImage(
    data: string,
    mimeType: string,
    index: number,
  ): Promise<string | undefined> {
    if (!this.saveImage) return undefined;
    const extension = mimeType.includes('jpeg') ? 'jpg' : 'png';
    return this.saveImage(
      `${Date.now()}-thumbnail-${index + 1}.${extension}`,
      data,
      mimeType,
    );
  }

  private async requestJson(
    url: string,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeoutMs = this.config.thumbnailTimeoutMs ?? this.config.requestTimeoutMs;
    const endpoint = this.safeEndpoint(url);
    this.logger('Thumbnail provider request started', {
      endpoint,
      timeoutMs,
    });
    const timeout = setTimeout(
      () => controller.abort(),
      timeoutMs,
    );
    try {
      const response = await this.fetcher(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...extraHeaders,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        this.logger('Thumbnail provider request failed', {
          endpoint,
          status: response.status,
          response: text.slice(0, 300),
        });
        throw new Error(`Thumbnail provider failed with HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      this.logger('Thumbnail provider request completed', {
        endpoint,
        status: response.status,
      });
      return text ? JSON.parse(text) as unknown : {};
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        this.logger('Thumbnail provider request timed out', {
          endpoint,
          timeoutMs,
        });
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
