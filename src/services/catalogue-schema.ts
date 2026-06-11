import { z } from 'zod';
import type { Promo } from '../promo-selector/types';

export const subscriptionLevelSchema = z.enum(['none', 'plus', 'premium']);
export const promoFormatSchema = z.enum(['inline', 'popup', 'fullscreen', 'topline', 'divkit', 'tooltip']);
export const audienceSchema = z.enum(['all', 'authenticated', 'anonymous']);
export const deviceTargetSchema = z.enum(['desktop', 'touch', 'both']);

/** Validation source of truth for a promo (mirrored by the cabinet). */
export const promoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  targeting: z.object({
    minAge: z.number().int().nonnegative().optional(),
    maxAge: z.number().int().nonnegative().optional(),
    regions: z.array(z.string()).optional(),
    subscriptionLevels: z.array(subscriptionLevelSchema).optional(),
  }),
  // Optional per-user cap. Legacy data used 0 = unlimited; coerce that to
  // undefined (the new "unlimited") so old catalogues still parse.
  maxImpressionsPerUser: z.preprocess(
    (v) => (v === 0 ? undefined : v),
    z.number().int().positive().optional(),
  ),
  cooldownHours: z.number().int().nonnegative(),
  format: promoFormatSchema,
  title: z.string().min(1),
  description: z.string().optional(),
  imageUrl: z.string().url().optional(),
  action: z.object({ href: z.string().min(1), label: z.string().optional() }).optional(),
  dismissible: z.boolean().optional(),
  backgroundColor: z.string().optional(),
  textColor: z.string().optional(),
  backgroundImage: z.string().optional(),
  backgroundGradient: z.object({
    from: z.string().min(1),
    to: z.string().min(1).optional(),
    angle: z.number().min(0).max(360).optional(),
  }).optional(),
  ctaColor: z.string().optional(),
  ctaTextColor: z.string().optional(),
  textAlign: z.enum(['left', 'center', 'right']).optional(),
  popupVariant: z.enum(['classic', 'split']).optional(),
  bullets: z.array(z.string().min(1).max(80)).max(6).optional(),
  /** DivKit-формат: URL на JSON-верстку в S3. abkhaz-auto fetch'ит и
   *  рендерит через @divkitframework/divkit (PromoRenderer 0.6.x). */
  divkitUrl: z.string().url().optional(),
  /** Tooltip format: id of the canonical host anchor element (host marks it
   *  data-promo-anchor="<id>"). Mirrors the cabinet schema. */
  anchor: z.string().min(1).optional(),
  sections: z.array(z.string().min(1)).optional(),
  categories: z.array(z.string().min(1)).optional(),
  audience: audienceSchema.optional(),
  sellerStatus: z.enum(['seller', 'buyer']).optional(),
  /**
   * Where the promo may show. Omitted/`'both'` = any device. The BFF
   * select-promo filters candidates by the request's `device` (см.
   * DeviceChecker): a `deviceTarget:'desktop'` promo is dropped for a touch
   * user and vice versa. Mirrors the cabinet schema. */
  deviceTarget: deviceTargetSchema.optional(),
});

// Pool schema; exported as `poolSchema` below. (`catalogueSchema` name kept for existing callers.)
export const catalogueSchema = z.array(promoSchema);

/** The pool is an array of promos. */
export const poolSchema = catalogueSchema;
/** The queue is an ordered array of promo ids. */
export const queueSchema = z.array(z.string().min(1));
/** Named queue object: persist flag + ordered ids. */
export const queueObjectSchema = z.object({
  persist: z.boolean().default(false),
  ids: z.array(z.string().min(1)).default([]),
});

// Compile-time guard: a parsed promo must satisfy the Promo domain type. If the
// schema drifts from `Promo`, this assignment fails `tsc --noEmit`.
type SchemaPromo = z.infer<typeof promoSchema>;
const _schemaMatchesDomain: (p: SchemaPromo) => Promo = (p) => p;
void _schemaMatchesDomain;
