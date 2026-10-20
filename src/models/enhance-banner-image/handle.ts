/**
 * enhance-banner-image: regenerate a banner's IMAGE via Google Nano Banana 2
 * (gemini-3.1-flash-image-preview). The cabinet sends the texts to bake, the
 * user's reference image URL and the target slot resolution; we craft a prompt
 * (see prompt.ts) that renders the new banner using the source as reference.
 *
 * Тонкая обёртка: строит cacheKey + промпт и делегирует общий пайплайн
 * (cache → rate-limit → model → webp-транскод → cost-log), см. banner-image-pipeline.
 * Делит rate-limit / cost-log с /enhance-promo — один бюджет на advertiserId.
 */
import { canonicalCacheKey } from '../../services/ai-cache';
import { runBannerImage, type BannerImagePipelineDeps } from '../../services/banner-image-pipeline';
import { bannerHeadlineText, buildEnhanceBannerImagePrompt } from './prompt';
import type { EnhanceBannerImageParams, EnhanceBannerImageResult } from './types';

// Реэкспорт общих типов — server.ts продолжает импортировать их отсюда.
export type { CachedBannerImage } from '../../services/banner-image-pipeline';
export type EnhanceBannerImageDeps = BannerImagePipelineDeps;

/** Версия промпта в ключе кэша: новая редакция не должна отдавать картинки,
 *  сгенерированные старой. Поднимать при каждой смене prompt.ts — она же
 *  входит в ключ /repair-banner-image (rebuild включает этот промпт). */
export const PROMPT_VERSION = 2;

export async function handleEnhanceBannerImage(
  params: EnhanceBannerImageParams,
  deps: EnhanceBannerImageDeps,
): Promise<EnhanceBannerImageResult> {
  // Same draft with a different CTA corner needs a different image (the model
  // leaves that corner free), so ctaPosition belongs in the cache key.
  const cacheKey = canonicalCacheKey({
    kind: 'enhance-banner-image',
    v: PROMPT_VERSION,
    advertiserId: params.advertiserId,
    imageUrl: params.imageUrl,
    width: params.width,
    height: params.height,
    draft: params.draft,
    ctaPosition: params.ctaPosition ?? 'br',
  });
  return runBannerImage(
    {
      advertiserId: params.advertiserId,
      cacheKey,
      prompt: buildEnhanceBannerImagePrompt(params),
      imageUrl: params.imageUrl,
      expectedText: bannerHeadlineText(params.draft),
      width: params.width,
      height: params.height,
      label: 'enhance-banner-image',
    },
    deps,
  );
}
