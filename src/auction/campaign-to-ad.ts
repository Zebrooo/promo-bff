/**
 * Builds the renderable Advertisement from a winning campaign candidate (B2C
 * sub-project 3). The id is namespaced `campaign:<dbId>` so the consumer's
 * existing impression report ties an impression back to its campaign for SP4
 * charging — no new response field needed. The stored creative was validated at
 * SP2 write-time; here we defensively read only known fields, coerce types, and
 * return null when the creative is malformed (missing/unknown format or blank
 * title) so the caller can exclude it before ranking.
 */
import type { CampaignCandidate } from '../services/campaign-service';
import type { Advertisement } from '../models/select-promo/types';
import type { PromoFormat } from '../promo-selector/types';

const FORMATS: readonly PromoFormat[] = ['inline', 'popup', 'fullscreen', 'topline', 'banner', 'tooltip'];
const MAX_IMAGE_DIMENSION = 10_000;

export interface AdTargetSize {
  width: number;
  height: number;
}

interface ImageVariant {
  imageUrl: string;
  width: number;
  height: number;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

function imageVariant(value: unknown): ImageVariant | null {
  if (typeof value !== 'object' || value === null) return null;
  const variant = value as Record<string, unknown>;
  const imageUrl = str(variant.imageUrl);
  const { width, height } = variant;
  if (
    imageUrl === undefined ||
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > MAX_IMAGE_DIMENSION ||
    height > MAX_IMAGE_DIMENSION
  ) {
    return null;
  }
  return { imageUrl, width, height };
}

function imageUrlForTarget(r: Record<string, unknown>, target: AdTargetSize | undefined): string | undefined {
  const fallback = str(r.imageUrl);
  if (
    target === undefined ||
    !Number.isFinite(target.width) ||
    !Number.isFinite(target.height) ||
    target.width <= 0 ||
    target.height <= 0
  ) {
    return fallback;
  }

  if (typeof r.imageVariants !== 'object' || r.imageVariants === null) return fallback;
  const rawVariants = r.imageVariants as Record<string, unknown>;
  const wide = imageVariant(rawVariants.wide);
  const compact = imageVariant(rawVariants.compact);
  // A partially written pair is never mixed with the legacy image: either the
  // complete art-directed set is usable, or the canonical imageUrl wins.
  if (wide === null || compact === null) return fallback;

  const targetAspect = target.width / target.height;
  return [wide, compact].reduce((best, candidate) => {
    const bestDistance = Math.abs(Math.log(targetAspect / (best.width / best.height)));
    const candidateDistance = Math.abs(Math.log(targetAspect / (candidate.width / candidate.height)));
    return candidateDistance < bestDistance ? candidate : best;
  }).imageUrl;
}

export function campaignToAd(c: CampaignCandidate, target?: AdTargetSize): Advertisement | null {
  const cr = c.creative;
  if (typeof cr !== 'object' || cr === null) return null;
  const r = cr as Record<string, unknown>;

  const format = r.format;
  if (typeof format !== 'string' || !(FORMATS as readonly string[]).includes(format)) return null;
  const title = str(r.title);
  if (!title) return null;

  // Tooltip creatives must carry the host anchor id (host marks the element
  // data-promo-anchor="<id>"); without it the renderer cannot position the bubble.
  const anchor = str(r.anchor);
  if (format === 'tooltip' && !anchor) return null;

  const ad: Advertisement = { id: `campaign:${c.id}`, format: format as PromoFormat, title };
  if (anchor !== undefined) ad.anchor = anchor;

  const description = str(r.description);
  if (description !== undefined) ad.description = description;
  const imageUrl = format === 'banner' && c.bannerFormat === 'horizontal'
    ? imageUrlForTarget(r, target)
    : str(r.imageUrl);
  if (imageUrl !== undefined) ad.imageUrl = imageUrl;
  const backgroundColor = str(r.backgroundColor);
  if (backgroundColor !== undefined) ad.backgroundColor = backgroundColor;
  const textColor = str(r.textColor);
  if (textColor !== undefined) ad.textColor = textColor;
  const backgroundImage = str(r.backgroundImage);
  if (backgroundImage !== undefined) ad.backgroundImage = backgroundImage;
  if (typeof r.dismissible === 'boolean') ad.dismissible = r.dismissible;

  if (typeof r.action === 'object' && r.action !== null) {
    const a = r.action as Record<string, unknown>;
    const href = str(a.href);
    if (href !== undefined) {
      const label = str(a.label);
      // Whitelist for CTA pill position — anything else is dropped.
      const POSITIONS = ['tl', 'tr', 'bl', 'br'] as const;
      const rawPos = str(a.position);
      const position = rawPos && (POSITIONS as readonly string[]).includes(rawPos) ? rawPos : undefined;
      ad.action = { href, ...(label !== undefined ? { label } : {}), ...(position !== undefined ? { position } : {}) };
    }
  }

  return ad;
}
