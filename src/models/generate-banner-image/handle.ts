/**
 * generate-banner-image: text-to-image для промо без референса.
 *
 * Использует тот же OpenrouterImageClient что и /enhance-banner-image
 * (Google Nano Banana 2 / gemini-3.1-flash-image-preview). Модель требует
 * imageUrl, но с пустым 1×1 white placeholder + детальным промптом она
 * успешно генерит из текста.
 *
 * Failure envelope как у других моделей — всегда HTTP 200, status в body.
 *   - rate-limit hit → `rate_limited`
 *   - openrouter / image-fetch failure → `image_unavailable`
 *   - empty / unparseable response → `malformed_response`
 *
 * Делит rate-limit и cost-log с /enhance-promo и /enhance-banner-image —
 * advertiserId один бюджет.
 */
import type { OpenrouterImageClient } from '../../services/openrouter-image-client';
import type { AiCache } from '../../services/ai-cache';
import type { RateLimitStore } from '../../services/rate-limit-store';
import type { CostLog } from '../../services/cost-log';
import { canonicalCacheKey } from '../../services/ai-cache';
import type { GenerateBannerImageParams, GenerateBannerImageResult } from './types';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface CachedGeneratedImage {
  imageDataUrl: string;
  model: string;
}

export interface GenerateBannerImageDeps {
  openrouterImage: OpenrouterImageClient;
  imageCache: AiCache<CachedGeneratedImage>;
  rateLimit: RateLimitStore;
  costLog: CostLog;
  logger?: Logger;
}

/** 1×1 пустой белый PNG. Нужен только чтобы передать в Nano Banana
 *  обязательный imageUrl — модель не использует его как референс при
 *  явной text-to-image инструкции. */
const BLANK_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

const PROMPT_TEMPLATE = (params: GenerateBannerImageParams): string => {
  const { width, height, prompt } = params;
  const lines: string[] = [];
  lines.push(`Generate a finished advertising banner image, exactly ${width}×${height} pixels, full-bleed, no margins or borders.`);
  lines.push('');
  lines.push('USER BRIEF (render the scene this describes):');
  lines.push(prompt);
  lines.push('');
  lines.push('FOCUS — HIGHEST PRIORITY:');
  lines.push('The entire image is in uniform sharp focus, edge to edge. Deep depth of field, everything in focus, crisp clean rendering. No shallow depth of field, no background blur, no bokeh.');
  lines.push('');
  lines.push('STYLE:');
  lines.push('Flat, graphic, modern poster aesthetic. Clean shapes, even studio-style lighting, uniform exposure. Solid or smoothly graded background. No vignette, no darkened gradients, no frosted overlays.');
  lines.push('');
  lines.push('TEXT POLICY:');
  lines.push('Do NOT render any text, captions, labels, watermarks, or signatures on the image. The headline/CTA will be overlaid by the host app — leave the composition uncluttered with space for text overlay on top.');
  lines.push('');
  lines.push('NEGATIVE — never include: blur, bokeh, defocus, motion blur, haze, frosted glass, depth-of-field falloff, semi-transparent panels, rendered text or labels, watermarks, "ad"/"sponsored" disclosure marks, low-quality artifacts.');
  return lines.join('\n');
};

export async function handleGenerateBannerImage(
  params: GenerateBannerImageParams,
  deps: GenerateBannerImageDeps,
): Promise<GenerateBannerImageResult> {
  const { openrouterImage, imageCache, rateLimit, costLog, logger } = deps;

  const cacheKey = canonicalCacheKey({
    kind: 'generate-banner-image',
    advertiserId: params.advertiserId,
    prompt: params.prompt,
    width: params.width,
    height: params.height,
  });
  const cached = imageCache.get(cacheKey);
  if (cached) {
    return { status: 'ok', data: { imageDataUrl: cached.imageDataUrl, cacheHit: true, model: cached.model } };
  }

  const limit = rateLimit.hit(params.advertiserId);
  if (!limit.ok) {
    return { status: 'error', reason: 'rate_limited' };
  }

  let result;
  try {
    result = await openrouterImage.call({
      prompt: PROMPT_TEMPLATE(params),
      imageUrl: BLANK_PLACEHOLDER,
    });
  } catch (err) {
    logger?.error({ err }, 'generate-banner-image: openrouter call failed');
    return { status: 'error', reason: 'image_unavailable' };
  }
  if (!result.imageDataUrl || !result.imageDataUrl.startsWith('data:image/')) {
    logger?.error({}, 'generate-banner-image: model returned no image');
    return { status: 'error', reason: 'malformed_response' };
  }

  imageCache.set(cacheKey, { imageDataUrl: result.imageDataUrl, model: result.model });
  try {
    await costLog.append({
      advertiserId: params.advertiserId,
      model: result.model,
      tokensIn: 0,
      tokensOut: 0,
      costRub: result.costRub,
    });
  } catch (err) {
    logger?.error({ err }, 'generate-banner-image: cost-log append failed (non-fatal)');
  }

  return { status: 'ok', data: { imageDataUrl: result.imageDataUrl, cacheHit: false, model: result.model } };
}
