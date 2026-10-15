/**
 * generate-banner-image: text-to-image для промо без референса. Тот же
 * OpenrouterImageClient (Nano Banana 2), референс не передаём вовсе — раньше
 * вместо него шёл 1×1 белый placeholder, и модель могла принять его за
 * образец формы и цвета. Форму кадра задаёт image_config в пайплайне.
 *
 * Тонкая обёртка над общим пайплайном (cache → rate-limit → model →
 * webp-транскод → cost-log), см. banner-image-pipeline. Делит бюджет с
 * /enhance-promo и /enhance-banner-image по advertiserId.
 */
import { canonicalCacheKey } from '../../services/ai-cache';
import { bannerShape, pickAspectRatio } from '../../services/banner-aspect';
import { runBannerImage, type BannerImagePipelineDeps } from '../../services/banner-image-pipeline';
import type { GenerateBannerImageParams, GenerateBannerImageResult } from './types';

// Реэкспорт общих типов (имена сохранены для обратной совместимости).
export type { CachedBannerImage as CachedGeneratedImage } from '../../services/banner-image-pipeline';
export type GenerateBannerImageDeps = BannerImagePipelineDeps;

/** Версия промпта в ключе кэша — см. enhance-banner-image/handle.ts. */
const PROMPT_VERSION = 2;

/** Картинка без текста: заголовок, описание и кнопку поверх неё рисует
 *  витрина (PromoRenderer), поэтому модели нужен спокойный фон под оверлей. */
export function buildGenerateBannerImagePrompt(params: GenerateBannerImageParams): string {
  const { width, height, prompt } = params;
  const aspect = pickAspectRatio(width, height);
  const shape = bannerShape(width, height);
  const shapeWords = shape === 'strip'
    ? `a very wide horizontal strip, aspect ratio ${aspect}`
    : shape === 'portrait'
      ? `a vertical poster, aspect ratio ${aspect}`
      : shape === 'square'
        ? `a square, aspect ratio ${aspect}`
        : `a landscape rectangle, aspect ratio ${aspect}`;
  const calmZone = shape === 'strip' ? 'the right 40 % of the width' : 'the lower 40 % of the height';

  const lines: string[] = [];
  lines.push(`Create the background artwork for a promotional banner on a Russian online classifieds site (cars, property, goods and services in Abkhazia). Output: ${shapeWords} (${width}×${height} px), full-bleed, no margins or border.`);
  lines.push('');
  lines.push('BRIEF (render this scene):');
  lines.push(prompt);
  lines.push('');
  lines.push('COMPOSITION');
  lines.push(`The website prints its own headline, text and button on top of this image, so the image itself carries no text at all — no words, letters, digits, logos, watermarks or signatures anywhere. Place the subject on the ${shape === 'strip' ? 'left' : 'upper'} side and keep ${calmZone} calm: plain continuous background, nothing drawn there. Keep every important detail at least 8 % away from the edges.`);
  lines.push('');
  lines.push('LOOK');
  lines.push('Bright, clean, premium commercial quality. Soft, even lighting; natural true-to-life colours; the whole frame uniformly sharp from edge to edge, background included (deep focus). The background is one calm continuous field — a solid colour or a smooth two-tone gradient — with no texture, pattern or scenery beyond what the brief asks for. No frames, badges, stickers, ribbons, buttons or panels.');
  lines.push('');
  lines.push(`Final check before you output: there is no text anywhere in the image; ${calmZone} is plain background; the image is ${aspect}.`);
  return lines.join('\n');
}

export async function handleGenerateBannerImage(
  params: GenerateBannerImageParams,
  deps: GenerateBannerImageDeps,
): Promise<GenerateBannerImageResult> {
  const cacheKey = canonicalCacheKey({
    kind: 'generate-banner-image',
    v: PROMPT_VERSION,
    advertiserId: params.advertiserId,
    prompt: params.prompt,
    width: params.width,
    height: params.height,
  });
  return runBannerImage(
    {
      advertiserId: params.advertiserId,
      cacheKey,
      prompt: buildGenerateBannerImagePrompt(params),
      width: params.width,
      height: params.height,
      label: 'generate-banner-image',
    },
    deps,
  );
}
