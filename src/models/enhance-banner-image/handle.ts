/**
 * enhance-banner-image: regenerate a banner's IMAGE via Google Nano Banana 2
 * (gemini-3.1-flash-image-preview). The cabinet sends the texts to bake, the
 * user's reference image URL and the target slot resolution; we craft a prompt
 * that renders the new banner at width×height using the source as reference.
 *
 * Тонкая обёртка: строит cacheKey + промпт и делегирует общий пайплайн
 * (cache → rate-limit → model → webp-транскод → cost-log), см. banner-image-pipeline.
 * Делит rate-limit / cost-log с /enhance-promo — один бюджет на advertiserId.
 */
import { canonicalCacheKey } from '../../services/ai-cache';
import { runBannerImage, type BannerImagePipelineDeps } from '../../services/banner-image-pipeline';
import type { EnhanceBannerImageParams, EnhanceBannerImageResult } from './types';

// Реэкспорт общих типов — server.ts продолжает импортировать их отсюда.
export type { CachedBannerImage } from '../../services/banner-image-pipeline';
export type EnhanceBannerImageDeps = BannerImagePipelineDeps;

/** English corner names — the prompt is in English (image models follow English
 *  more precisely), but the RENDERED texts stay Russian, verbatim. */
const CORNER_EN: Record<string, { name: string; opposite: string }> = {
  tl: { name: 'TOP-LEFT', opposite: 'BOTTOM-RIGHT' },
  tr: { name: 'TOP-RIGHT', opposite: 'BOTTOM-LEFT' },
  bl: { name: 'BOTTOM-LEFT', opposite: 'TOP-RIGHT' },
  br: { name: 'BOTTOM-RIGHT', opposite: 'TOP-LEFT' },
};

const PROMPT_TEMPLATE = (params: EnhanceBannerImageParams): string => {
  const { width, height, draft } = params;
  const ctaKey = params.ctaPosition && CORNER_EN[params.ctaPosition] ? params.ctaPosition : 'br';
  const corner = CORNER_EN[ctaKey];
  const ctaCorner = corner.name.toLowerCase();
  const ctaOppositeCorner = corner.opposite.toLowerCase();

  const lines: string[] = [];
  lines.push(`You are generating a finished, full-bleed advertising banner, exactly ${width}×${height} pixels. No margins, no frame, no border.`);
  lines.push('');
  lines.push('FOCUS — HIGHEST PRIORITY:');
  lines.push('The entire image is in uniform sharp focus, edge to edge. Deep depth of field, everything in focus, crisp clean rendering, even f/16-style sharpness across the whole frame. Do NOT inherit shallow depth of field, background blur, bokeh or soft focus from any input imagery — override it and render every region equally sharp.');
  lines.push('');
  lines.push('STYLE:');
  lines.push('Flat, graphic, modern poster aesthetic. Clean shapes, even studio-style lighting, uniform exposure. Solid or smoothly graded background — not a photographic studio backdrop. No vignette, no darkened gradients, no frosted overlays anywhere.');
  lines.push('');
  lines.push('TEXT (render EXACTLY as written, verbatim, in Russian — no translation, no transliteration, no paraphrasing, correct Cyrillic):');
  if (draft.title) lines.push(`- Headline, primary weight: "${draft.title}"`);
  if (draft.description) lines.push(`- Subheadline, smaller, secondary weight: "${draft.description}"`);
  lines.push('');
  lines.push('COMPOSITION — STRICT:');
  lines.push(`Anchor the main subject and the rendered text in the ${ctaOppositeCorner} half of the banner.`);
  lines.push(`The ${ctaCorner} corner (~30% width × 25% height) and the top-left corner (~15% width × 12% height) contain ONLY plain background — the SAME flat color or smooth gradient as the rest of the banner's background, continuous across these areas, with NO focal elements, NO subject parts, NO product details, NO logos, NO rendered text, and ESPECIALLY no glass panels, no frosted plates, no blur patches, no darkened areas, no semi-transparent shapes, no rectangles, no rounded buttons, no badges, no pills, no overlays of any kind.`);
  lines.push('These two corners must look EXACTLY like the rest of the background — flat, sharp, with nothing on them. Do NOT mark them off. Do NOT prepare them for anything. Just background.');
  lines.push('');
  lines.push('NEGATIVE — never include anywhere in the image: blur, bokeh, defocus, soft focus, motion blur, haze, frosted glass, depth-of-field falloff, out-of-focus regions, semi-transparent panels, rounded button shapes, badges, pills, stickers, "ad"/"sponsored"/"promo" disclosure marks, smudged or illegible text.');
  return lines.join('\n');
};

export async function handleEnhanceBannerImage(
  params: EnhanceBannerImageParams,
  deps: EnhanceBannerImageDeps,
): Promise<EnhanceBannerImageResult> {
  // Same draft with a different CTA corner needs a different image (the model
  // leaves that corner free), so ctaPosition belongs in the cache key.
  const cacheKey = canonicalCacheKey({
    kind: 'enhance-banner-image',
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
      prompt: PROMPT_TEMPLATE(params),
      imageUrl: params.imageUrl,
      width: params.width,
      height: params.height,
      label: 'enhance-banner-image',
    },
    deps,
  );
}
