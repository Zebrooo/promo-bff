/**
 * generate-banner-image: text-to-image для промо без референса. Тот же
 * OpenrouterImageClient (Nano Banana 2); модель требует imageUrl, поэтому
 * передаём 1×1 white placeholder + детальный текстовый промпт.
 *
 * Тонкая обёртка над общим пайплайном (cache → rate-limit → model →
 * webp-транскод → cost-log), см. banner-image-pipeline. Делит бюджет с
 * /enhance-promo и /enhance-banner-image по advertiserId.
 */
import { canonicalCacheKey } from '../../services/ai-cache';
import { runBannerImage, type BannerImagePipelineDeps } from '../../services/banner-image-pipeline';
import type { GenerateBannerImageParams, GenerateBannerImageResult } from './types';

// Реэкспорт общих типов (имена сохранены для обратной совместимости).
export type { CachedBannerImage as CachedGeneratedImage } from '../../services/banner-image-pipeline';
export type GenerateBannerImageDeps = BannerImagePipelineDeps;

/** 1×1 пустой белый PNG — только чтобы передать обязательный imageUrl; при явной
 *  text-to-image инструкции модель его не использует как референс. */
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
  const cacheKey = canonicalCacheKey({
    kind: 'generate-banner-image',
    advertiserId: params.advertiserId,
    prompt: params.prompt,
    width: params.width,
    height: params.height,
  });
  return runBannerImage(
    {
      advertiserId: params.advertiserId,
      cacheKey,
      prompt: PROMPT_TEMPLATE(params),
      imageUrl: BLANK_PLACEHOLDER,
      width: params.width,
      height: params.height,
      label: 'generate-banner-image',
    },
    deps,
  );
}
