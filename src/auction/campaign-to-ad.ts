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

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}

export function campaignToAd(c: CampaignCandidate): Advertisement | null {
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
  const imageUrl = str(r.imageUrl);
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
