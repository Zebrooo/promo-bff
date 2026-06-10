/** Public types for POST /enhance-promo. Mirrors the envelope shape used by
 *  select-promo / auction so the cabinet can treat the response uniformly. */
import type { ModelResult } from '../select-promo/types';

/** Partial promo the cabinet is working on. We don't impose the full Promo
 *  schema here — the BFF only enhances text fields and treats the rest as
 *  opaque (so the cabinet can pass an in-progress object freely). */
export interface PromoDraft {
  title?: string;
  description?: string;
  action?: { href?: string; label?: string };
  /** Anything else the cabinet might send is preserved opaquely. */
  [key: string]: unknown;
}

/** Page descriptor from the cabinet's AD_PAGES list. Used both as whitelist
 *  for `pages` suggestions and as context for the LLM (which sections exist). */
export interface AvailablePage {
  key: string;
  name: string;
}

export interface EnhanceParams {
  /** Whose budget / rate-limit bucket — the cabinet admin user id (we have no
   *  per-promo owner; see ownership decision in session notes). */
  advertiserId: string;
  /** Draft to improve. */
  draft: PromoDraft;
  /** When present — BFF may return pages-suggestions; values are restricted to
   *  these keys. When absent (back-compat for promo-cabinet) — BFF omits the
   *  pages-suggestion entirely. */
  availablePages?: AvailablePage[];
}

/** Pages-suggestion sub-object — keys must be a subset of EnhanceParams.availablePages. */
export interface PromoPagesSuggestion {
  keys: string[];
  reason: string;
}

/** CPM-suggestion sub-object — value is in roubles, validated to [1, 50]. */
export interface PromoCpmSuggestion {
  value: number;
  reason: string;
}

/** Fields the model is allowed to suggest changes for. Omitting a field means
 *  "no improvement needed for this one". */
export interface PromoSuggestions {
  title?: string;
  description?: string;
  action?: { label?: string };
  pages?: PromoPagesSuggestion;
  cpm?: PromoCpmSuggestion;
}

export interface EnhanceData {
  suggestions: PromoSuggestions;
  /** True when the response came from cache (no new OpenRouter call billed). */
  cacheHit: boolean;
  /** Model that produced (or originally produced, on cache hit) the suggestions. */
  model: string;
}

export type EnhanceResult =
  | { status: 'ok'; data: EnhanceData }
  | { status: 'error'; reason: string };

export type { ModelResult };
