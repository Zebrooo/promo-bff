/** Public request/response types for the select-promo model. */

import type { Promo } from '../../promo-selector/types';

export interface SelectPromoParams {
  userId: string;
  context?: {
    platform?: string;
    locale?: string;
    /** Page section the user is browsing (overlay context gate). */
    section?: string;
    /** Page category the user is browsing. */
    category?: string;
  };
  /** Named queue to load; defaults to 'main'. */
  queue?: string;
  /** Checker names to skip (e.g. ['limit','cooldown']). */
  skipCheckers?: string[];
  /**
   * Inline user context from the client: identity + audience gate. Profile and
   * subscription are sourced by the BFF's userData supplier, not passed in.
   */
  user?: {
    id?: string;
    authenticated?: boolean;
  };
}

/**
 * What the BFF hands the renderer: the whole promo MINUS server-only selection
 * fields (schedule window, targeting, cooldown, audience gate, internal name).
 * Derived from Promo via Omit so any renderable field added to Promo flows
 * through automatically — we never re-enumerate creative fields here.
 */
export type Advertisement = Omit<
  Promo,
  'name' | 'startsAt' | 'endsAt' | 'targeting' | 'maxImpressionsPerUser' | 'cooldownHours' | 'audience' | 'sections' | 'categories' | 'sellerStatus'
>;

/**
 * Per-model result. HTTP stays 200; this status is how a client tells
 * "no promo matched" (skipped) apart from "a dependency failed" (error).
 */
export type ModelResult =
  | { status: 'ok'; data: Advertisement }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string };
