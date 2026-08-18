import { z } from 'zod';
import type { Promo } from '../promo-selector/types';
import { isValidNormalizedSearchTerm } from '../util/search-normalization';

export const subscriptionLevelSchema = z.enum(['none', 'plus', 'premium']);
export const promoFormatSchema = z.enum(['inline', 'popup', 'fullscreen', 'topline', 'divkit', 'tooltip', 'multistep', 'custom']);
export const audienceSchema = z.enum(['all', 'authenticated', 'anonymous']);
export const deviceTargetSchema = z.enum(['desktop', 'touch', 'both']);
export const promoOsSchema = z.enum(['ios', 'android']);
export const promoEnvironmentSchema = z.enum(['browser', 'telegram', 'pwa', 'app']);
export const deviceBrandSchema = z.enum(['iphone', 'android-flagship', 'android-other']);
export const geoSegmentSchema = z.enum(['local', 'tourist', 'other']);
export const entrySourceSchema = z.enum(['direct', 'search', 'telegram', 'other']);
export const visitorClassSchema = z.enum(['newcomer', 'regular']);

export const searchTargetingSchema = z.object({
  terms: z.array(
    z.string().trim().min(2).max(80).regex(/[\p{L}\p{N}]/u).refine(isValidNormalizedSearchTerm),
  ).max(20).optional(),
  sections: z.array(z.string().trim().min(1).max(40).regex(/[\p{L}\p{N}]/u)).max(20).optional(),
  match: z.enum(['any', 'all']).optional(),
  lookbackDays: z.number().int().min(1).max(30).optional(),
});

export const packTypeSchema = z.enum(['bump', 'premium', 'vip']);

export const purchasesTargetingSchema = z.object({
  purchased: z.boolean().optional(),
  minTotalKopecks: z.number().int().nonnegative().optional(),
  maxTotalKopecks: z.number().int().nonnegative().optional(),
  minCount: z.number().int().nonnegative().optional(),
  maxCount: z.number().int().nonnegative().optional(),
  packTypes: z.array(packTypeSchema).optional(),
  lookbackDays: z.number().int().min(1).max(365).optional(),
});

export const balanceTargetingSchema = z.object({
  currentAbove: z.number().int().optional(),
  currentBelow: z.number().int().optional(),
  movementAbove: z.number().int().optional(),
  movementBelow: z.number().int().optional(),
  movementLookbackDays: z.number().int().min(1).max(365).optional(),
});

export const listingsTargetingSchema = z.object({
  categories: z.array(z.string().min(1)).optional(),
  categoriesMatch: z.enum(['any', 'all']).optional(),
  activeCategories: z.array(z.string().min(1)).optional(),
  hasUnpromotedActive: z.boolean().optional(),
  inactiveDays: z.number().int().nonnegative().optional(),
});

/** Dayparting-блок (спека targeting-schedule §3). Зеркалит scheduleSchema
 *  кабинета, но с .catch(undefined) на месте использования — кривое
 *  ОПЦИОНАЛЬНОЕ поле не должно ронять всё промо в parsePoolLeniently
 *  (намеренная асимметрия: кабинет строгий, BFF снисходительный, fail-open). */
export const scheduleSchema = z.object({
  daysOfWeek: z.array(z.number().int().min(1).max(7))
    .min(1)
    .refine((d) => new Set(d).size === d.length),
  hourStart: z.number().int().min(0).max(23),
  hourEnd: z.number().int().min(1).max(24),
}).refine((s) => s.hourStart < s.hourEnd);

/** Validation source of truth for a promo (mirrored by the cabinet). */
export const promoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  schedule: scheduleSchema.optional().catch(undefined),
  targeting: z.object({
    minAge: z.number().int().nonnegative().optional(),
    maxAge: z.number().int().nonnegative().optional(),
    regions: z.array(z.string()).optional(),
    subscriptionLevels: z.array(subscriptionLevelSchema).optional(),
    os: z.array(promoOsSchema).optional(),
    environments: z.array(promoEnvironmentSchema).optional(),
    deviceBrands: z.array(deviceBrandSchema).optional(),
    /** IP-гео (GeoChecker): сегменты «где сейчас» + города-слаги. Mirrors the cabinet schema. */
    geoSegments: z.array(geoSegmentSchema).optional(),
    geoCities: z.array(z.string().min(1).max(64)).optional(),
    /** Профиль визита (VisitorChecker): newcomer/regular + пороги. Mirrors the cabinet schema. */
    visitorClass: visitorClassSchema.optional(),
    newcomerMaxAgeDays: z.number().int().min(1).max(365).optional(),
    regularMinVisitDays: z.number().int().min(1).max(30).optional(),
    search: searchTargetingSchema.optional(),
    purchases: purchasesTargetingSchema.optional(),
    balance: balanceTargetingSchema.optional(),
    listings: listingsTargetingSchema.optional(),
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
  /** Custom format only: picks the host-owned render function via the
   *  <PromoProvider customFormats> map. Field-level optional here; the cabinet
   *  enforces "required + registered variant" for format==='custom'. Mirrors
   *  the cabinet schema. */
  variant: z.string().min(1).max(64).optional(),
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
   *  cabinet schema byte-for-byte (title ≤ 80, body ≤ 240; optional per-step
   *  imageUrl — http(s) picture/gif, ≤ 1024 chars — rendered in the stage
   *  zone by MultistepPromo with priority over the host multistepStage slot). */
  steps: z.array(z.object({
    title: z.string().min(1).max(80),
    body:  z.string().min(1).max(240),
    imageUrl: z.string().url().max(1024).optional(),
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
  /** Источник захода (SourceChecker). БЕЗ .min(1): пустой массив в руками
   *  правленном пуле должен пройти парс и молча скипнуть чекер, а не выронить
   *  промо целиком из parsePoolLeniently. Mirrors the cabinet schema. */
  entrySources: z.array(entrySourceSchema).optional(),
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
