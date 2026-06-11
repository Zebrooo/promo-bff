import type { SelectPromoParams } from './types';

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
    result.skipCheckers = p.skipCheckers as string[];
  }

  if (p.device !== undefined) {
    if (p.device !== 'desktop' && p.device !== 'touch') {
      return { ok: false, error: "params.device must be 'desktop' or 'touch'" };
    }
    result.device = p.device;
  }

  if (userObj !== null) {
    result.user = userObj as SelectPromoParams['user'];
  }

  return { ok: true, params: result };
}
