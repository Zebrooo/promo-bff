/** Public request/response types for the select-promo model. */

import type { Promo } from '../../promo-selector/types';
import type { IdentityKind } from '../../promo-selector/checkers/Checker';
export type { IdentityKind } from '../../promo-selector/checkers/Checker';

export interface SelectPromoUser {
  id?: string;
  /** Canonical login-state flag; used only by the audience checker. */
  isAuthorized?: boolean;
  /** Controls whether account-backed suppliers may use this stable id. */
  identityKind?: IdentityKind;
  /**
   * Short-lived Ed25519 proof binding an explicit account identity to this id.
   * Required for new callers that send identityKind:'account'.
   */
  identityProof?: string;
  /** @deprecated Input alias for isAuthorized. */
  authenticated?: boolean;
}

export interface SelectPromoParams {
  userId: string;
  /** Stable anonymous/authenticated viewer key used to read AA search history. */
  viewerKey?: string;
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
   * Creative formats the requesting surface accepts (e.g. ['topline'] for the top
   * banner, ['popup','fullscreen','inline','divkit'] for the overlay). Lets one
   * per-catalog queue serve multiple surfaces; the FormatChecker keeps only
   * matching promos. Omitted/empty = no format filter (back-compat).
   */
  formats?: string[];
  /**
   * Requesting device class. When set, the DeviceChecker drops promos whose
   * `deviceTarget` or `format` is incompatible (so select-promo falls through
   * to the next eligible promo). Omitted = no device filtering (back-compat;
   * gating then stays client-side in the renderer).
   */
  device?: 'desktop' | 'touch' | 'app';
  /**
   * Promo ids to exclude from selection (dropped BEFORE the checkers run).
   * Lets a sequential consumer (e.g. the cabinet-onboarding tour) advance past
   * promos it already showed this session without waiting for the impression
   * beacon to land. Max 50 ids, each 1..64 chars. Omitted/empty = no exclusion.
   */
  excludeIds?: string[];
  /**
   * Inline user context from the client: identity + audience gate. Profile and
   * subscription are sourced by the BFF's userData supplier, not passed in.
   */
  user?: SelectPromoUser;
}

/** Normalize canonical input and direct legacy in-process handler calls. */
export function resolveUserIdentity(user?: SelectPromoUser): {
  isAuthorized: boolean;
  identityKind: IdentityKind;
} {
  const isAuthorized = user?.isAuthorized ?? user?.authenticated ?? false;
  return {
    isAuthorized,
    identityKind: user?.identityKind ?? (isAuthorized ? 'account' : 'anonymous'),
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

/**
 * select-promo-list result: the WHOLE ordered, eligibility-filtered sequence in
 * one response (onboarding tour). Same envelope policy as ModelResult (HTTP 200;
 * status distinguishes an empty tour from a dependency failure). Kept NEXT TO
 * ModelResult — not merged into it — so the generic /models envelope is untouched.
 */
export type PromoListResult =
  | { status: 'ok'; steps: Advertisement[] }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string };
