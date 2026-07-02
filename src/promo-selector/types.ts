/** Domain types for promo selection. */

export type SubscriptionLevel = 'none' | 'plus' | 'premium';

export type PromoFormat = 'inline' | 'popup' | 'fullscreen' | 'topline' | 'banner' | 'divkit' | 'tooltip' | 'multistep';

export interface PromoTargeting {
  minAge?: number;
  maxAge?: number;
  /** Allowed regions; empty/omitted means "all regions". */
  regions?: string[];
  /** Allowed subscription levels; empty/omitted means "any level". */
  subscriptionLevels?: SubscriptionLevel[];
}

/**
 * A promo as stored in the S3 pool (promos.json). Queue membership/order lives in
 * queue-<name>.json, not by position here; a promo carries its own targeting, show window
 * and cooldown. Each checker reads only the fields it owns.
 */
export interface Promo {
  id: string;
  name: string;
  /** Show window, ISO-8601 timestamps. */
  startsAt: string;
  endsAt: string;
  targeting: PromoTargeting;
  /** Max times one user may see this promo. Omitted = unlimited (limit checker skipped). */
  maxImpressionsPerUser?: number;
  /** Minimum hours between two shows to the same user. 0 = no cooldown. */
  cooldownHours: number;
  /** Chain: id of the predecessor promo. When set, this promo is eligible only
   *  after the user has at least one recorded impression of that predecessor
   *  (см. ChainChecker). Omitted = no chaining. */
  afterPromoId?: string;
  /** Display format for the renderer. */
  format: PromoFormat;
  /** User-facing headline. */
  title: string;
  description?: string;
  imageUrl?: string;
  /** CTA: deep link/route + optional label + optional pill position (tl/tr/bl/br;
   *  default "br" on the storefront). */
  action?: { href: string; label?: string; position?: string };
  /** Overlays: whether the user can dismiss it (default true). */
  dismissible?: boolean;
  /** Banner/overlay background colour (CSS color). */
  backgroundColor?: string;
  /** Banner/overlay text colour (CSS color). */
  textColor?: string;
  /** Background image URL for popup/fullscreen overlays. */
  backgroundImage?: string;
  /** Linear gradient background (preferred over backgroundColor when set, ignored if backgroundImage). */
  backgroundGradient?: { from: string; to?: string; angle?: number };
  /** CTA button background color (CSS). Only used when `action` is set. */
  ctaColor?: string;
  /** CTA button text color (CSS). */
  ctaTextColor?: string;
  /** Text alignment inside overlay/inline body. Default 'left'. */
  textAlign?: 'left' | 'center' | 'right';
  /** Popup layout variant: 'classic' = title+desc stacked, 'split' = image-left/text-right. */
  popupVariant?: 'classic' | 'split';
  /** Optional bullet list rendered below description (max 6 × 80 chars). */
  bullets?: string[];
  /** DivKit format: URL to JSON-tree in S3 (rendered via @divkitframework/divkit). */
  divkitUrl?: string;
  /** Tooltip format only: id of the canonical host anchor element to point at
   *  (host marks it data-promo-anchor="<id>"). Required when format===='tooltip'. */
  anchor?: string;
  /** Multistep format only: wizard steps (2..6, title ≤ 80 / body ≤ 240 — the
   *  cabinet enforces the bounds). Rendered by @zebrooo/promo-renderer's
   *  MultistepPromo. A renderable field: select-promo hands it to the client
   *  untouched (NOT in the handle.ts server-only strip list).
   *  `imageUrl` (optional, http(s) URL ≤ 1024, png/jpg/webp/gif) — per-step
   *  picture/gif shown in the wizard's stage zone; takes priority over the
   *  host multistepStage slot (@zebrooo/promo-renderer 0.12.0). */
  steps?: { title: string; body: string; imageUrl?: string }[];
  /** Multistep format only: how the wizard presents itself — 'modal' (default,
   *  centered dialog) or 'fullscreen' (full-viewport takeover; renderer's
   *  zr-multistep--fullscreen, @zebrooo/promo-renderer 0.11.0). A renderable
   *  field: handed to the client untouched (NOT in the handle.ts strip list). */
  presentation?: 'modal' | 'fullscreen';
  /** Page sections this promo may show in (e.g. ['avto','realty']). Omitted = any section. */
  sections?: string[];
  /** Page categories this promo may show in. Omitted = any category. */
  categories?: string[];
  /** Audience gate: 'all'/omitted = everyone; 'authenticated' = logged-in users only; 'anonymous' = guests only. */
  audience?: 'all' | 'authenticated' | 'anonymous';
  /** Restrict to sellers (has active listings) or buyers (none). Omitted = either. */
  sellerStatus?: 'seller' | 'buyer';
  /** Device gate: 'desktop'/'touch' restricts to that device; 'both'/omitted = any.
   *  Enforced by the DeviceChecker against the request's `device`. */
  deviceTarget?: 'desktop' | 'touch' | 'both';
}
