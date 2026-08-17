import { WEB_CHECKERS } from '../../promo-selector/checkers';
import type { SelectPromoParams } from './types';
import type { PromoEnvSignal } from '../../promo-selector/types';

/**
 * Names a consumer may pass in skipCheckers — derived from the registered
 * checker collection (single source of truth; adding a checker automatically
 * extends the allowlist). An unknown name is rejected up front instead of
 * being silently ignored by the selector's `skip.includes(...)` filter.
 */
const KNOWN_CHECKER_NAMES = WEB_CHECKERS.map((c) => c.name);

/** Bounds for params.excludeIds: a session-seen list, not a bulk filter. */
const MAX_EXCLUDE_IDS = 50;

/** Enum-значения params.env — зеркала PromoEnvSignal (см. promo-selector/types). */
const PROMO_OS_VALUES: readonly string[] = ['ios', 'android'];
const PROMO_ENVIRONMENT_VALUES: readonly string[] = ['browser', 'telegram', 'pwa', 'app'];
const DEVICE_BRAND_VALUES: readonly string[] = ['iphone', 'android-flagship', 'android-other'];
const MAX_EXCLUDE_ID_LENGTH = 64;
const MAX_VIEWER_KEY_LENGTH = 128;

export type ValidationResult =
  | { ok: true; params: SelectPromoParams }
  | { ok: false; error: string };

export interface ValidationOptions {
  /** Verifies a signed account-continuity proof against the effective user id. */
  verifyIdentityProof?: (proof: string, expectedSub: string) => boolean;
}

/**
 * Validates the `params` of a select-promo request.
 * A user id is required: either params.userId or params.user.id.
 */
export function validateParams(params: unknown, opts: ValidationOptions = {}): ValidationResult {
  if (typeof params !== 'object' || params === null) {
    return { ok: false, error: 'params must be an object' };
  }

  const p = params as Record<string, unknown>;

  // Resolve one unambiguous datasource identity. A mismatch must not silently
  // read profile data for one id and impression data for another.
  const topLevelUserId = p.userId;
  if (p.user !== undefined && (typeof p.user !== 'object' || p.user === null || Array.isArray(p.user))) {
    return { ok: false, error: 'params.user must be an object' };
  }
  const userObj = p.user === undefined ? null : (p.user as Record<string, unknown>);
  const inlineUserId = userObj?.id;

  if (topLevelUserId !== undefined && (typeof topLevelUserId !== 'string' || topLevelUserId.trim() === '')) {
    return { ok: false, error: 'params.userId is required and must be a non-empty string' };
  }
  if (inlineUserId !== undefined && (typeof inlineUserId !== 'string' || inlineUserId.trim() === '')) {
    return { ok: false, error: 'params.user.id must be a non-empty string' };
  }
  if (typeof topLevelUserId === 'string' && typeof inlineUserId === 'string' && topLevelUserId !== inlineUserId) {
    return { ok: false, error: 'params.userId and params.user.id must match when both are provided' };
  }

  const userId = typeof topLevelUserId === 'string'
    ? topLevelUserId
    : typeof inlineUserId === 'string'
      ? inlineUserId
      : null;

  if (userId === null) {
    return { ok: false, error: 'params.userId is required and must be a non-empty string' };
  }

  const result: SelectPromoParams = { userId };

  if (p.viewerKey !== undefined) {
    if (typeof p.viewerKey !== 'string') {
      return { ok: false, error: 'params.viewerKey must be a non-empty string' };
    }
    const viewerKey = p.viewerKey.trim();
    if (viewerKey === '' || viewerKey.length > MAX_VIEWER_KEY_LENGTH) {
      return {
        ok: false,
        error: `params.viewerKey must be a non-empty string of at most ${MAX_VIEWER_KEY_LENGTH} characters`,
      };
    }
    result.viewerKey = viewerKey;
  }

  if (typeof p.context === 'object' && p.context !== null) {
    result.context = p.context as SelectPromoParams['context'];
  }

  if (p.queue !== undefined) {
    if (typeof p.queue !== 'string' || p.queue.trim() === '') {
      return { ok: false, error: 'params.queue must be a non-empty string' };
    }
    result.queue = p.queue;
  }

  if (p.skipCheckers !== undefined) {
    if (
      !Array.isArray(p.skipCheckers) ||
      p.skipCheckers.some((s) => typeof s !== 'string')
    ) {
      return { ok: false, error: 'params.skipCheckers must be an array of strings' };
    }
    const unknown = (p.skipCheckers as string[]).filter((s) => !KNOWN_CHECKER_NAMES.includes(s));
    if (unknown.length > 0) {
      return {
        ok: false,
        error: `params.skipCheckers contains unknown checker(s): ${unknown.join(', ')}; allowed: ${KNOWN_CHECKER_NAMES.join(', ')}`,
      };
    }
    result.skipCheckers = p.skipCheckers as string[];
  }

  if (p.formats !== undefined) {
    if (
      !Array.isArray(p.formats) ||
      p.formats.some((s) => typeof s !== 'string')
    ) {
      return { ok: false, error: 'params.formats must be an array of strings' };
    }
    // Drop empties/whitespace so a stray '' can't exclude every promo.
    const formats = (p.formats as string[]).map((s) => s.trim()).filter((s) => s !== '');
    if (formats.length > 0) result.formats = formats;
  }

  if (p.excludeIds !== undefined) {
    if (
      !Array.isArray(p.excludeIds) ||
      p.excludeIds.some((s) => typeof s !== 'string')
    ) {
      return { ok: false, error: 'params.excludeIds must be an array of strings' };
    }
    // Strict: the client controls this list, so garbage is rejected up front
    // instead of silently dropped (an empty id would never match anything and
    // an unbounded list would let a client inflate the request body).
    if (p.excludeIds.length > MAX_EXCLUDE_IDS) {
      return { ok: false, error: `params.excludeIds must contain at most ${MAX_EXCLUDE_IDS} ids` };
    }
    const invalid = (p.excludeIds as string[]).some((s) => s.length < 1 || s.length > MAX_EXCLUDE_ID_LENGTH);
    if (invalid) {
      return {
        ok: false,
        error: `params.excludeIds elements must be 1..${MAX_EXCLUDE_ID_LENGTH} characters long`,
      };
    }
    result.excludeIds = p.excludeIds as string[];
  }

  if (p.device !== undefined) {
    if (p.device !== 'desktop' && p.device !== 'touch' && p.device !== 'app') {
      return { ok: false, error: "params.device must be 'desktop', 'touch' or 'app'" };
    }
    result.device = p.device;
  }

  if (p.env !== undefined) {
    if (typeof p.env !== 'object' || p.env === null || Array.isArray(p.env)) {
      return { ok: false, error: 'params.env must be an object' };
    }
    const e = p.env as Record<string, unknown>;
    if (e.os !== undefined && (typeof e.os !== 'string' || !PROMO_OS_VALUES.includes(e.os))) {
      return { ok: false, error: "params.env.os must be 'ios' or 'android'" };
    }
    if (e.runtime !== undefined && (typeof e.runtime !== 'string' || !PROMO_ENVIRONMENT_VALUES.includes(e.runtime))) {
      return { ok: false, error: "params.env.runtime must be 'browser', 'telegram', 'pwa' or 'app'" };
    }
    if (e.brand !== undefined && (typeof e.brand !== 'string' || !DEVICE_BRAND_VALUES.includes(e.brand))) {
      return { ok: false, error: "params.env.brand must be 'iphone', 'android-flagship' or 'android-other'" };
    }
    // Канонический выход: только известные ключи (мусор дальше валидатора не идёт).
    const env: PromoEnvSignal = {
      ...(e.os !== undefined ? { os: e.os as PromoEnvSignal['os'] } : {}),
      ...(e.runtime !== undefined ? { runtime: e.runtime as PromoEnvSignal['runtime'] } : {}),
      ...(e.brand !== undefined ? { brand: e.brand as PromoEnvSignal['brand'] } : {}),
    };
    if (Object.keys(env).length > 0) result.env = env;
  }

  if (userObj !== null) {
    if (userObj.isAuthorized !== undefined && typeof userObj.isAuthorized !== 'boolean') {
      return { ok: false, error: 'params.user.isAuthorized must be a boolean' };
    }
    if (userObj.authenticated !== undefined && typeof userObj.authenticated !== 'boolean') {
      return { ok: false, error: 'params.user.authenticated must be a boolean' };
    }
    if (
      userObj.isAuthorized !== undefined &&
      userObj.authenticated !== undefined &&
      userObj.isAuthorized !== userObj.authenticated
    ) {
      return { ok: false, error: 'params.user.isAuthorized conflicts with params.user.authenticated' };
    }
    if (
      userObj.identityKind !== undefined &&
      userObj.identityKind !== 'account' &&
      userObj.identityKind !== 'anonymous'
    ) {
      return { ok: false, error: "params.user.identityKind must be 'account' or 'anonymous'" };
    }
    if (userObj.identityProof !== undefined && (typeof userObj.identityProof !== 'string' || userObj.identityProof === '')) {
      return { ok: false, error: 'params.user.identityProof must be a non-empty string' };
    }

    const isAuthorized = (userObj.isAuthorized ?? userObj.authenticated ?? false) as boolean;
    const identityKind = (userObj.identityKind ?? (isAuthorized ? 'account' : 'anonymous')) as 'account' | 'anonymous';
    if (isAuthorized && identityKind === 'anonymous') {
      return { ok: false, error: "params.user.identityKind cannot be 'anonymous' when isAuthorized is true" };
    }
    // New explicit account identities are privacy-sensitive, including while
    // authorized: cryptographically bind the account id rather than trusting a
    // request field. Omitted identityKind retains the legacy auth-derived
    // behavior so the BFF can deploy before existing callers are upgraded.
    if (userObj.identityKind === 'account') {
      const proof = userObj.identityProof;
      if (typeof proof !== 'string' || opts.verifyIdentityProof?.(proof, userId) !== true) {
        return { ok: false, error: 'params.user account identity proof is invalid' };
      }
    }

    // Canonical output: do not forward the legacy alias or arbitrary fields.
    result.user = {
      ...(typeof inlineUserId === 'string' ? { id: inlineUserId } : {}),
      isAuthorized,
      identityKind,
    };
  }

  return { ok: true, params: result };
}
