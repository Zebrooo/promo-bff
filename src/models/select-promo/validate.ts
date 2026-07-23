import { WEB_CHECKERS } from '../../promo-selector/checkers';
import type { SelectPromoParams } from './types';

/**
 * Names a consumer may pass in skipCheckers — derived from the registered
 * checker collection (single source of truth; adding a checker automatically
 * extends the allowlist). An unknown name is rejected up front instead of
 * being silently ignored by the selector's `skip.includes(...)` filter.
 */
const KNOWN_CHECKER_NAMES = WEB_CHECKERS.map((c) => c.name);

/** Bounds for params.excludeIds: a session-seen list, not a bulk filter. */
const MAX_EXCLUDE_IDS = 50;
const MAX_EXCLUDE_ID_LENGTH = 64;

export type ValidationResult =
  | { ok: true; params: SelectPromoParams }
  | { ok: false; error: string };

/**
 * Validates the `params` of a select-promo request.
 * A user id is required: either params.userId or params.user.id.
 */
export function validateParams(params: unknown): ValidationResult {
  if (typeof params !== 'object' || params === null) {
    return { ok: false, error: 'params must be an object' };
  }

  const p = params as Record<string, unknown>;

  // Resolve the effective userId: top-level params.userId takes precedence over params.user.id
  const topLevelUserId = p.userId;
  const userObj = typeof p.user === 'object' && p.user !== null ? (p.user as Record<string, unknown>) : null;
  const inlineUserId = userObj?.id;

  const userId = typeof topLevelUserId === 'string' && topLevelUserId.trim() !== ''
    ? topLevelUserId
    : typeof inlineUserId === 'string' && inlineUserId.trim() !== ''
      ? inlineUserId
      : null;

  if (userId === null) {
    return { ok: false, error: 'params.userId is required and must be a non-empty string' };
  }

  const result: SelectPromoParams = { userId };

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

  if (userObj !== null) {
    // Strict: a stringly "false" would coerce truthy downstream and flip the
    // audience gate; only an actual boolean (or absence) is accepted.
    if (userObj.authenticated !== undefined && typeof userObj.authenticated !== 'boolean') {
      return { ok: false, error: 'params.user.authenticated must be a boolean' };
    }
    result.user = userObj as SelectPromoParams['user'];
  }

  return { ok: true, params: result };
}
