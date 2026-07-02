import { z } from 'zod';
import type { Promo } from '../promo-selector/types';

export const subscriptionLevelSchema = z.enum(['none', 'plus', 'premium']);
export const promoFormatSchema = z.enum(['inline', 'popup', 'fullscreen', 'topline', 'divkit', 'tooltip', 'multistep']);
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
  /** Chain: id of the predecessor promo — this promo shows only after the user
   *  has a recorded impression of it (ChainChecker). Mirrors the cabinet schema. */
  afterPromoId: z.string().min(1).max(64).optional(),
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
  /** Multistep format: wizard steps (2..6). Optional at the field level;
   *  required for format==='multistep' via the refine below. Mirrors the
   *  cabinet schema byte-for-byte (title ≤ 80, body ≤ 240). */
  steps: z.array(z.object({
    title: z.string().min(1).max(80),
    body:  z.string().min(1).max(240),
  })).min(2).max(6).optional(),
  /** Multistep only: 'modal' (default) or 'fullscreen'. Applicable to the
   *  multistep format only (refine below). Mirrors the cabinet schema. */
  presentation: z.enum(['modal', 'fullscreen']).optional(),
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
})
  // Multistep needs its steps — a step-less wizard would render to nothing on
  // the storefront (fail-safe null), so reject it here like the cabinet does.
  // With parsePoolLeniently this drops ONLY the broken promo, not the pool.
  .refine((p) => p.format !== 'multistep' || (Array.isArray(p.steps) && p.steps.length >= 2), {
    message: 'steps (2..6) are required for the multistep format',
    path: ['steps'],
  })
  // presentation is a multistep-only knob (the cabinet sanitizes it away for
  // every other format) — mirror the cabinet refine so a hand-edited pool
  // can't smuggle it onto formats the renderer ignores it for.
  .refine((p) => p.presentation === undefined || p.format === 'multistep', {
    message: 'presentation is only supported by the multistep format',
    path: ['presentation'],
  });

// Pool schema; exported as `poolSchema` below. (`catalogueSchema` name kept for existing callers.)
export const catalogueSchema = z.array(promoSchema);

/** The pool is an array of promos. */
export const poolSchema = catalogueSchema;

export interface LenientPoolResult {
  /** Promos that passed promoSchema, in original pool order. */
  promos: Promo[];
  /** Items that failed promoSchema, with their zod issues (for logging). */
  rejected: { promoId: string; issues: z.ZodIssue[] }[];
}

/**
 * Per-item pool parsing: one corrupt promo must not dark every slot on the
 * site (poolSchema.parse on the whole array would). Invalid entries are
 * dropped and reported to the caller; a pool that is not an array at all
 * still throws — that's a config error, not a single bad record.
 */
export function parsePoolLeniently(raw: unknown): LenientPoolResult {
  const items = z.array(z.unknown()).parse(raw);
  const promos: Promo[] = [];
  const rejected: LenientPoolResult['rejected'] = [];
  for (const item of items) {
    const res = promoSchema.safeParse(item);
    if (res.success) {
      promos.push(res.data);
    } else {
      const id = (item as { id?: unknown } | null)?.id;
      rejected.push({ promoId: typeof id === 'string' ? id : '<no id>', issues: res.error.issues });
    }
  }
  return { promos, rejected };
}
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
