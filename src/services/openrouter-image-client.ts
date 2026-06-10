/**
 * OpenRouter image-generation/editing client (default: Google "Nano Banana 2"
 * = `google/gemini-3.1-flash-image-preview`). The model takes a text prompt
 * + an input image and returns a NEW image (text rendered onto the banner).
 *
 * Same shape as openrouter-client.ts (factory + injectable fetch + RUB cost
 * estimate), so tests can mock `fetch` without hitting real OpenRouter.
 *
 * Output: a base64 data URL. The caller is responsible for uploading it
 * somewhere durable (the cabinet's /api/enhance-banner-image proxies the data
 * URL to Supabase Storage so the cabinet UI can display a public https://...).
 */
import { config as appConfig } from '../config';

export interface OpenrouterImageConfig {
  apiKey: string;
  imageModel: string;
  /** Price per generated image (USD). Image-gen models bill per output, not
   *  per token, so we track cost flat-rate. Override via env. */
  pricePerImageUsd: number;
  usdRub: number;
  /** Generous — image gen can take 20-40s. */
  timeoutMs: number;
}

export interface OpenrouterImageCallParams {
  /** Plain instructions for the model. */
  prompt: string;
  /** Input image (the user's original) as an `https://...` URL or base64
   *  data URL. The model uses it as a visual reference / edit source. */
  imageUrl: string;
  /** Override the default image model id. */
  model?: string;
}

export interface OpenrouterImageCallResult {
  /** Generated image as a base64 data URL (e.g. `data:image/png;base64,…`). */
  imageDataUrl: string;
  /** Model id that actually served the call. */
  model: string;
  /** Flat RUB cost estimate for the call. */
  costRub: number;
}

export interface OpenrouterImageClient {
  call(params: OpenrouterImageCallParams): Promise<OpenrouterImageCallResult>;
}

export interface OpenrouterImageClientOverrides {
  config?: Partial<OpenrouterImageConfig>;
  fetchImpl?: typeof fetch;
  referer?: string;
  appTitle?: string;
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export function createOpenrouterImageClient(overrides: OpenrouterImageClientOverrides = {}): OpenrouterImageClient {
  const cfg: OpenrouterImageConfig = { ...appConfig.openrouterImage, ...overrides.config };
  const fetchImpl = overrides.fetchImpl ?? fetch;
  const referer = overrides.referer;
  const appTitle = overrides.appTitle;

  return {
    async call(params) {
      if (!cfg.apiKey) {
        throw new Error('openrouter-image: OPENROUTER_API_KEY is not configured');
      }
      const model = params.model ?? cfg.imageModel;

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      };
      if (referer) headers['HTTP-Referer'] = referer;
      if (appTitle) headers['X-Title'] = appTitle;

      // Multi-modal user message: text prompt + the source image.
      const body = JSON.stringify({
        model,
        modalities: ['image', 'text'],
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: params.prompt },
            { type: 'image_url', image_url: { url: params.imageUrl } },
          ],
        }],
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      let resp: Response;
      try {
        resp = await fetchImpl(ENDPOINT, { method: 'POST', headers, body, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        const name = (err as { name?: string } | null)?.name;
        if (name === 'AbortError') throw new Error(`openrouter-image: timed out after ${cfg.timeoutMs}ms`);
        throw err;
      }
      clearTimeout(timer);

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`openrouter-image: ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`);
      }

      const json = (await resp.json()) as {
        model?: string;
        choices?: Array<{
          message?: {
            content?: string;
            images?: Array<{ type?: string; image_url?: { url?: string } }>;
          };
        }>;
      };

      // OpenRouter for Gemini image models returns the generated image under
      // `choices[0].message.images[0].image_url.url` as a base64 data URL.
      // We're tolerant of variations: any data: URL in known image positions.
      const imageDataUrl = extractImageDataUrl(json);
      if (!imageDataUrl) {
        throw new Error('openrouter-image: response had no image in choices[0].message.images');
      }

      return {
        imageDataUrl,
        model: json.model ?? model,
        costRub: Math.round(cfg.pricePerImageUsd * cfg.usdRub * 10000) / 10000,
      };
    },
  };
}

/** Pull a base64 image data URL out of OpenRouter's chat-completions response.
 *  Tolerant of shape variations seen in image-output Gemini models. */
function extractImageDataUrl(json: {
  choices?: Array<{
    message?: {
      content?: string;
      images?: Array<{ type?: string; image_url?: { url?: string } }>;
    };
  }>;
}): string | null {
  const msg = json.choices?.[0]?.message;
  if (!msg) return null;
  // 1) Canonical shape — choices[0].message.images[].image_url.url
  if (Array.isArray(msg.images)) {
    for (const img of msg.images) {
      const url = img?.image_url?.url;
      if (typeof url === 'string' && url.startsWith('data:image/')) return url;
    }
  }
  // 2) Fallback — sometimes the data URL leaks into message.content as text.
  if (typeof msg.content === 'string') {
    const m = msg.content.match(/data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/);
    if (m) return m[0];
  }
  return null;
}
