/**
 * Общий пайплайн генерации баннер-картинки для /enhance-banner-image,
 * /repair-banner-image и /generate-banner-image (раньше у enhance и generate
 * были две почти идентичные копии). Шаги:
 *   cache get → rate-limit → референс base64 → [openrouter call → validate →
 *   transcode webp → cost-log → проверка заголовка]×≤2 → cache set → ok
 *
 * Хендлеры остаются тонкими: строят cacheKey + prompt (+ imageUrl-референс,
 * + expectedText для сверки) и зовут runBannerImage. Failure envelope — как у
 * всех моделей (HTTP 200, status в body).
 *
 * Соотношение сторон модели задаётся здесь из целевых W×H (pickAspectRatio):
 * модель рисует кадр почти нужной формы, а cover-кроп транскода остаётся
 * страховкой на остаток (4:1 → 4,83:1 у телефонной полосы), а не ножом.
 * Режет он по содержимому (attention); repair просит по центру (`crop`), чтобы
 * знать, какие края уйдут, — см. banner-image-transcode.ts.
 *
 * Проверка заголовка (headline-check.ts): готовый webp читает дешёвая
 * мультимодальная модель; если ожидаемого текста на нём нет — одна повторная
 * генерация. После второй попытки картинка отдаётся как есть: лучше баннер с
 * риском опечатки, чем отказ. Сбой самой проверки картинку не блокирует.
 */
import type { OpenrouterImageClient } from './openrouter-image-client';
import type { AiCache } from './ai-cache';
import type { RateLimitStore } from './rate-limit-store';
import type { CostLog } from './cost-log';
import { pickAspectRatio } from './banner-aspect';
import type { ReferenceInliner } from './reference-image';
import { headlineMatches, type HeadlineChecker } from './headline-check';
import { transcodeBannerToWebp, type BannerCrop } from './banner-image-transcode';

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
  /** Скачивает референс из нашего хранилища и вкладывает его base64 — см.
   *  reference-image.ts. Без него адрес уходит модели как есть. */
  inlineReference?: ReferenceInliner;
  /** Читает текст с готового баннера для сверки с expectedText. Без него
   *  сверки нет. */
  headlineChecker?: HeadlineChecker;
  logger?: Logger;
}

export interface BannerImageRequest {
  /** Rate-limit + cost-log attribution (cabinet user UUID / promo id). */
  advertiserId: string;
  /** Готовый ключ кэша (строит вызывающий — у каждой модели свои поля). */
  cacheKey: string;
  /** Полный промпт для модели. */
  prompt: string;
  /** Референс-картинка (enhance); у text-to-image (generate) её нет. */
  imageUrl?: string;
  /** Целевые размеры слота — под них просим форму кадра и кропим результат. */
  width: number;
  height: number;
  /** Текст, который обязан быть на баннере; сверяется с готовой картинкой. */
  expectedText?: string;
  /** Как вписать кадр модели в W×H; по умолчанию attention. centre — когда
   *  промпт задаёт позиции в долях готового файла (repair). */
  crop?: BannerCrop;
  /** Префикс для лог-сообщений, напр. 'enhance-banner-image'. */
  label: string;
}

export type BannerImagePipelineResult =
  | { status: 'ok'; data: { imageDataUrl: string; cacheHit: boolean; model: string } }
  | { status: 'error'; reason: string };

/** Вторая генерация — одна: каждая стоит как первая. */
const MAX_ATTEMPTS = 2;

export async function runBannerImage(
  req: BannerImageRequest,
  deps: BannerImagePipelineDeps,
): Promise<BannerImagePipelineResult> {
  const { openrouterImage, imageCache, rateLimit, costLog, inlineReference, headlineChecker, logger } = deps;

  const cached = imageCache.get(req.cacheKey);
  if (cached) {
    return { status: 'ok', data: { imageDataUrl: cached.imageDataUrl, cacheHit: true, model: cached.model } };
  }

  if (!rateLimit.hit(req.advertiserId).ok) {
    return { status: 'error', reason: 'rate_limited' };
  }

  let imageUrl = req.imageUrl;
  if (imageUrl && inlineReference) {
    try {
      imageUrl = await inlineReference(imageUrl);
    } catch (err) {
      logger?.error({ err }, `${req.label}: reference fetch failed`);
      return { status: 'error', reason: 'image_unavailable' };
    }
  }

  const generateOnce = async (): Promise<CachedBannerImage | { reason: string }> => {
    let result;
    try {
      result = await openrouterImage.call({
        prompt: req.prompt,
        imageUrl,
        aspectRatio: pickAspectRatio(req.width, req.height),
      });
    } catch (err) {
      logger?.error({ err }, `${req.label}: openrouter call failed`);
      return { reason: 'image_unavailable' };
    }
    if (!result.imageDataUrl || !result.imageDataUrl.startsWith('data:image/')) {
      logger?.error({}, `${req.label}: model returned no image`);
      return { reason: 'malformed_response' };
    }

    // Транскод в webp + умный кроп под слот. Fail-closed: без подтверждённого
    // точного W×H этот результат нельзя сохранять как адаптивный вариант.
    const imageDataUrl = await transcodeBannerToWebp(result.imageDataUrl, req.width, req.height, { crop: req.crop });
    if (!imageDataUrl) {
      logger?.error({}, `${req.label}: image transcode failed`);
      return { reason: 'image_unavailable' };
    }

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
    return { imageDataUrl, model: result.model };
  };

  let image: CachedBannerImage | undefined;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const generated = await generateOnce();
    if ('reason' in generated) return { status: 'error', reason: generated.reason };
    image = generated;
    if (!req.expectedText || !headlineChecker) break;

    let transcription: string;
    try {
      transcription = await headlineChecker.transcribe(generated.imageDataUrl);
    } catch (err) {
      logger?.error({ err }, `${req.label}: headline check failed, accepting the image unchecked`);
      break;
    }
    if (headlineMatches(transcription, req.expectedText)) break;
    logger?.info(
      { attempt, expected: req.expectedText, transcription: transcription.slice(0, 300) },
      attempt < MAX_ATTEMPTS
        ? `${req.label}: headline mismatch, regenerating`
        : `${req.label}: headline still mismatched, returning the last image`,
    );
  }

  imageCache.set(req.cacheKey, image!);
  return { status: 'ok', data: { imageDataUrl: image!.imageDataUrl, cacheHit: false, model: image!.model } };
}
