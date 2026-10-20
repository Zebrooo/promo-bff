/**
 * repair-banner-image: модератор витрины доводит баннер рекламодателя до
 * рекламных мест — бережно (careful) или собирая заново (rebuild), см. prompt.ts.
 *
 * Тонкая обёртка над общим пайплайном (cache → rate-limit → model →
 * webp-транскод → cost-log), как /enhance-banner-image. Бюджет — по
 * advertiserId; сайт шлёт «mod:<adminUserId>», так что правки модератора не
 * съедают лимит рекламодателя.
 */
import { canonicalCacheKey } from '../../services/ai-cache';
import { runBannerImage, type BannerImagePipelineDeps } from '../../services/banner-image-pipeline';
import { PROMPT_VERSION as ENHANCE_PROMPT_VERSION } from '../enhance-banner-image/handle';
import { bannerHeadlineText } from '../enhance-banner-image/prompt';
import { buildRepairBannerImagePrompt } from './prompt';
import type { RepairBannerImageParams, RepairBannerImageResult } from './types';

export type RepairBannerImageDeps = BannerImagePipelineDeps;

/** Версия промпта в ключе кэша — см. enhance-banner-image/handle.ts.
 *  Поднимать при каждой смене prompt.ts; смену промпта enhance (rebuild его
 *  включает) ключ ловит сам — через enhanceV. */
const PROMPT_VERSION = 1;

export async function handleRepairBannerImage(
  params: RepairBannerImageParams,
  deps: RepairBannerImageDeps,
): Promise<RepairBannerImageResult> {
  // В ключе — всё, что меняет картинку. Порядок правок в запросе на промпт не
  // влияет (строки идут в порядке REPAIR_FIXES), поэтому сортируем.
  const cacheKey = canonicalCacheKey({
    kind: 'repair-banner-image',
    v: PROMPT_VERSION,
    enhanceV: ENHANCE_PROMPT_VERSION,
    advertiserId: params.advertiserId,
    imageUrl: params.imageUrl,
    width: params.width,
    height: params.height,
    mode: params.mode,
    fixes: [...params.fixes].sort(),
    notes: params.notes ?? null,
    safeArea: params.safeArea ?? null,
    reservedZone: params.reservedZone ?? null,
    draft: params.draft,
    ctaPosition: params.ctaPosition ?? 'br',
    variant: params.variant ?? 0,
  });
  return runBannerImage(
    {
      advertiserId: params.advertiserId,
      cacheKey,
      prompt: buildRepairBannerImagePrompt(params),
      imageUrl: params.imageUrl,
      // rebuild пишет заголовок из draft — его и сверяем, как enhance. В
      // careful текст берётся с самого баннера, а его мы не знаем: сверки нет,
      // сайт перед применением требует отметку «текст проверил» от человека.
      expectedText: params.mode === 'rebuild' ? bannerHeadlineText(params.draft) : undefined,
      width: params.width,
      height: params.height,
      // Зоны модератора и запас от краёв в промпте пересчитаны под срез по
      // центру (prompt.ts) — кроп по содержимому сдвинул бы их.
      crop: 'centre',
      label: 'repair-banner-image',
    },
    deps,
  );
}
