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
import type { BannerCrop } from '../../services/banner-image-transcode';
import { bannerHeadlineText } from '../enhance-banner-image/prompt';
import { buildRepairBannerImagePrompt } from './prompt';
import type { RepairBannerImageParams, RepairBannerImageResult } from './types';

export type RepairBannerImageDeps = BannerImagePipelineDeps;

/** Зоны модератора и запас от краёв в промпте пересчитаны под срез по центру
 *  (prompt.ts) — кроп по содержимому сдвинул бы их. */
const CROP: BannerCrop = 'centre';

export async function handleRepairBannerImage(
  params: RepairBannerImageParams,
  deps: RepairBannerImageDeps,
): Promise<RepairBannerImageResult> {
  const prompt = buildRepairBannerImagePrompt(params);
  // rebuild пишет заголовок из draft — его и сверяем, как enhance. В careful
  // текст берётся с самого баннера, а его мы не знаем: сверки нет, сайт перед
  // применением требует отметку «текст проверил» от человека.
  const expectedText = params.mode === 'rebuild' ? bannerHeadlineText(params.draft) : undefined;
  // В ключе — ровно то, что уходит модели и в транскод: сам промпт (в нём уже
  // режим, правки в порядке REPAIR_FIXES, зоны, указания, черновик — и любая
  // будущая правка prompt.ts или промпта enhance, без номеров версий),
  // референс, размер, кроп, сверяемый текст и номер варианта. Поля запроса,
  // которых в промпте нет (черновик в careful, зона без своей правки), ключ
  // не меняют — повтор не стоит новой генерации.
  const cacheKey = canonicalCacheKey({
    kind: 'repair-banner-image',
    advertiserId: params.advertiserId,
    imageUrl: params.imageUrl,
    width: params.width,
    height: params.height,
    crop: CROP,
    prompt,
    expectedText: expectedText ?? null,
    variant: params.variant ?? 0,
  });
  return runBannerImage(
    {
      advertiserId: params.advertiserId,
      cacheKey,
      prompt,
      imageUrl: params.imageUrl,
      expectedText,
      width: params.width,
      height: params.height,
      crop: CROP,
      label: 'repair-banner-image',
    },
    deps,
  );
}
