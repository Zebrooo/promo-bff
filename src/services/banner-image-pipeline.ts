/**
 * Общий пайплайн генерации баннер-картинки, разделяемый /enhance-banner-image и
 * /generate-banner-image (раньше две почти идентичные копии). Шаги:
 *   cache get → rate-limit → openrouter call → validate → transcode webp → cache set
 *   → cost-log → ok
 *
 * Хендлеры остаются тонкими: строят cacheKey + prompt + imageUrl (референс или
 * 1×1 placeholder) и зовут runBannerImage. Failure envelope — как у всех моделей
 * (HTTP 200, status в body).
 */
import type { OpenrouterImageClient } from './openrouter-image-client';
import type { AiCache } from './ai-cache';
import type { RateLimitStore } from './rate-limit-store';
import type { CostLog } from './cost-log';
import { transcodeBannerToWebp } from './banner-image-transcode';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Кэш-значение — достаточно для реконструкции ответа на хите. */
export interface CachedBannerImage {
  imageDataUrl: string;
  model: string;
}

export interface BannerImagePipelineDeps {
  openrouterImage: OpenrouterImageClient;
  imageCache: AiCache<CachedBannerImage>;
  rateLimit: RateLimitStore;
  costLog: CostLog;
  logger?: Logger;
}

export interface BannerImageRequest {
  /** Rate-limit + cost-log attribution (cabinet user UUID / promo id). */
  advertiserId: string;
  /** Готовый ключ кэша (строит вызывающий — у каждой модели свои поля). */
  cacheKey: string;
  /** Полный промпт для модели. */
  prompt: string;
  /** Референс-картинка (enhance) или 1×1 placeholder (generate). */
  imageUrl: string;
  /** Целевые размеры слота — под них кропим/ресайзим результат. */
  width: number;
  height: number;
  /** Префикс для лог-сообщений, напр. 'enhance-banner-image'. */
  label: string;
}

export type BannerImagePipelineResult =
  | { status: 'ok'; data: { imageDataUrl: string; cacheHit: boolean; model: string } }
  | { status: 'error'; reason: string };

export async function runBannerImage(
  req: BannerImageRequest,
  deps: BannerImagePipelineDeps,
): Promise<BannerImagePipelineResult> {
  const { openrouterImage, imageCache, rateLimit, costLog, logger } = deps;

  const cached = imageCache.get(req.cacheKey);
  if (cached) {
    return { status: 'ok', data: { imageDataUrl: cached.imageDataUrl, cacheHit: true, model: cached.model } };
  }

  if (!rateLimit.hit(req.advertiserId).ok) {
    return { status: 'error', reason: 'rate_limited' };
  }

  let result;
  try {
    result = await openrouterImage.call({ prompt: req.prompt, imageUrl: req.imageUrl });
  } catch (err) {
    logger?.error({ err }, `${req.label}: openrouter call failed`);
    return { status: 'error', reason: 'image_unavailable' };
  }
  if (!result.imageDataUrl || !result.imageDataUrl.startsWith('data:image/')) {
    logger?.error({}, `${req.label}: model returned no image`);
    return { status: 'error', reason: 'malformed_response' };
  }

  // Транскод в webp + умный кроп под слот. На ошибке/без sharp — passthrough.
  const imageDataUrl = await transcodeBannerToWebp(result.imageDataUrl, req.width, req.height);

  imageCache.set(req.cacheKey, { imageDataUrl, model: result.model });
  try {
    await costLog.append({
      advertiserId: req.advertiserId,
      model: result.model,
      tokensIn: 0,
      tokensOut: 0,
      costRub: result.costRub,
    });
  } catch (err) {
    logger?.error({ err }, `${req.label}: cost-log append failed (best-effort)`);
  }

  return { status: 'ok', data: { imageDataUrl, cacheHit: false, model: result.model } };
}
