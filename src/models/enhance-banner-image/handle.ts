/**
 * enhance-banner-image: regenerate a banner's IMAGE via Google Nano Banana 2
 * (gemini-3.1-flash-image-preview by default). The cabinet sends the texts to
 * bake, the user's reference image URL, and the target slot resolution; we
 * craft a prompt that instructs the model to render the new banner at the
 * requested width×height, using the source image as visual reference.
 *
 * Reuses the same rate-limit-store and cost-log instances as `/enhance-promo`,
 * so a single advertiser shares a budget across both endpoints (they're both
 * AI operations on the same draft).
 *
 * Failure envelope follows the BFF convention — always HTTP 200, status in body.
 *   - rate-limit hit → `rate_limited`
 *   - openrouter / image-fetch failure → `image_unavailable`
 *   - empty / unparseable response → `malformed_response`
 */
import type { OpenrouterImageClient } from '../../services/openrouter-image-client';
import type { AiCache } from '../../services/ai-cache';
import type { RateLimitStore } from '../../services/rate-limit-store';
import type { CostLog } from '../../services/cost-log';
import { canonicalCacheKey } from '../../services/ai-cache';
import type { EnhanceBannerImageParams, EnhanceBannerImageResult } from './types';

export interface Logger {
  info(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Cache value — just enough to reconstruct the response on a hit. */
export interface CachedBannerImage {
  imageDataUrl: string;
  model: string;
}

export interface EnhanceBannerImageDeps {
  openrouterImage: OpenrouterImageClient;
  /** Renamed from `cache` to avoid intersection-type clash with EnhanceDeps,
   *  which has its own (text-suggestion) cache of a different generic type. */
  imageCache: AiCache<CachedBannerImage>;
  rateLimit: RateLimitStore;
  costLog: CostLog;
  logger?: Logger;
}

/** English corner names — the prompt itself is in English (image models tend
 *  to follow English instructions more precisely), but the texts the model
 *  RENDERS onto the image must stay in Russian, verbatim. */
const CORNER_EN: Record<string, { name: string; opposite: string }> = {
  tl: { name: 'TOP-LEFT',     opposite: 'BOTTOM-RIGHT' },
  tr: { name: 'TOP-RIGHT',    opposite: 'BOTTOM-LEFT'  },
  bl: { name: 'BOTTOM-LEFT',  opposite: 'TOP-RIGHT'    },
  br: { name: 'BOTTOM-RIGHT', opposite: 'TOP-LEFT'     },
};

const PROMPT_TEMPLATE = (params: EnhanceBannerImageParams): string => {
  const { width, height, draft } = params;
  const ctaKey = params.ctaPosition && CORNER_EN[params.ctaPosition] ? params.ctaPosition : 'br';
  const corner = CORNER_EN[ctaKey];
  // CORNER_EN хранит имена UPPERCASE ("BOTTOM-RIGHT"); промпт читается естественнее
  // в lowercase ("bottom-right") — приводим здесь.
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
  const { openrouterImage, imageCache, rateLimit, costLog, logger } = deps;

  // 1. Cache — keyed by (advertiserId, imageUrl, dims, draft, ctaPosition).
  //    Same draft with a different CTA corner needs a different image (the
  //    model is asked to leave that corner free), so the position belongs
  //    in the key.
  const cacheKey = canonicalCacheKey({
    kind: 'enhance-banner-image',
    advertiserId: params.advertiserId,
    imageUrl: params.imageUrl,
    width: params.width,
    height: params.height,
    draft: params.draft,
    ctaPosition: params.ctaPosition ?? 'br',
  });
  const cached = imageCache.get(cacheKey);
  if (cached) {
    return { status: 'ok', data: { imageDataUrl: cached.imageDataUrl, cacheHit: true, model: cached.model } };
  }

  // 2. Rate-limit (shared with /enhance-promo for one budget per advertiser).
  const limit = rateLimit.hit(params.advertiserId);
  if (!limit.ok) {
    return { status: 'error', reason: 'rate_limited' };
  }

  // 3. Call Nano Banana 2.
  let result;
  try {
    result = await openrouterImage.call({
      prompt: PROMPT_TEMPLATE(params),
      imageUrl: params.imageUrl,
    });
  } catch (err) {
    logger?.error({ err }, 'enhance-banner-image: openrouter call failed');
    return { status: 'error', reason: 'image_unavailable' };
  }
  if (!result.imageDataUrl || !result.imageDataUrl.startsWith('data:image/')) {
    logger?.error({}, 'enhance-banner-image: model returned no image');
    return { status: 'error', reason: 'malformed_response' };
  }

  // 4. Cache + cost log (best-effort).
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
    logger?.error({ err }, 'enhance-banner-image: cost-log append failed (best-effort)');
  }

  return {
    status: 'ok',
    data: { imageDataUrl: result.imageDataUrl, cacheHit: false, model: result.model },
  };
}
