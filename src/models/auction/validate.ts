import type { AuctionExposure, AuctionParams, AuctionPositionParam, FeedFillParams } from './types';

const MAX_SLOT_DIMENSION = 10_000;
const MAX_GROUP_LENGTH = 128;

export type ValidationResult =
  | { ok: true; params: AuctionParams }
  | { ok: false; error: string };

/** Validates POST /auction: a non-empty `slots` array of { slot, weight }. */
export function validateAuctionParams(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;

  if (!Array.isArray(b.slots) || b.slots.length === 0) {
    return { ok: false, error: 'slots is required and must be a non-empty array' };
  }

  let exposure: AuctionExposure = 'simultaneous';
  if (b.exposure !== undefined) {
    if (b.exposure !== 'simultaneous' && b.exposure !== 'sequence' && b.exposure !== 'mixed') {
      return { ok: false, error: 'exposure must be simultaneous, sequence, or mixed' };
    }
    exposure = b.exposure;
  }

  const slots: AuctionPositionParam[] = [];
  let hasMixedGroup = false;
  for (const raw of b.slots) {
    if (typeof raw !== 'object' || raw === null) return { ok: false, error: 'each slot must be an object' };
    const s = raw as Record<string, unknown>;
    if (typeof s.slot !== 'string' || s.slot.trim() === '') return { ok: false, error: 'slot must be a non-empty string' };
    if (typeof s.weight !== 'number' || !Number.isFinite(s.weight)) return { ok: false, error: 'weight must be a number' };
    const pos: AuctionPositionParam = { slot: s.slot, weight: s.weight };
    if (s.format !== undefined) {
      if (typeof s.format !== 'string') return { ok: false, error: 'slot.format must be a string' };
      pos.format = s.format;
    }
    if (s.sequenceGroup !== undefined && s.coDisplayGroup !== undefined) {
      return { ok: false, error: 'slot.sequenceGroup and slot.coDisplayGroup are mutually exclusive' };
    }
    if (s.sequenceGroup !== undefined) {
      if (exposure !== 'mixed') {
        return { ok: false, error: 'slot.sequenceGroup is only allowed when exposure is mixed' };
      }
      if (typeof s.sequenceGroup !== 'string') {
        return { ok: false, error: 'slot.sequenceGroup must be a string' };
      }
      const sequenceGroup = s.sequenceGroup.trim();
      if (sequenceGroup === '' || sequenceGroup.length > MAX_GROUP_LENGTH) {
        return {
          ok: false,
          error: `slot.sequenceGroup must be a non-empty string up to ${MAX_GROUP_LENGTH} characters`,
        };
      }
      pos.sequenceGroup = sequenceGroup;
      hasMixedGroup = true;
    }
    if (s.coDisplayGroup !== undefined) {
      if (exposure !== 'mixed') {
        return { ok: false, error: 'slot.coDisplayGroup is only allowed when exposure is mixed' };
      }
      if (typeof s.coDisplayGroup !== 'string') {
        return { ok: false, error: 'slot.coDisplayGroup must be a string' };
      }
      const coDisplayGroup = s.coDisplayGroup.trim();
      if (coDisplayGroup === '' || coDisplayGroup.length > MAX_GROUP_LENGTH) {
        return {
          ok: false,
          error: `slot.coDisplayGroup must be a non-empty string up to ${MAX_GROUP_LENGTH} characters`,
        };
      }
      pos.coDisplayGroup = coDisplayGroup;
      hasMixedGroup = true;
    }
    const hasWidth = s.width !== undefined;
    const hasHeight = s.height !== undefined;
    if (hasWidth !== hasHeight) {
      return { ok: false, error: 'slot.width and slot.height must be provided together' };
    }
    if (hasWidth && hasHeight) {
      if (
        typeof s.width !== 'number' ||
        typeof s.height !== 'number' ||
        !Number.isInteger(s.width) ||
        !Number.isInteger(s.height) ||
        s.width <= 0 ||
        s.height <= 0 ||
        s.width > MAX_SLOT_DIMENSION ||
        s.height > MAX_SLOT_DIMENSION
      ) {
        return {
          ok: false,
          error: `slot.width and slot.height must be positive integers up to ${MAX_SLOT_DIMENSION}`,
        };
      }
      pos.width = s.width;
      pos.height = s.height;
    }
    const hasSingletonWidth = s.singletonWidth !== undefined;
    const hasSingletonHeight = s.singletonHeight !== undefined;
    if (hasSingletonWidth !== hasSingletonHeight) {
      return {
        ok: false,
        error: 'slot.singletonWidth and slot.singletonHeight must be provided together',
      };
    }
    if (hasSingletonWidth && hasSingletonHeight) {
      if (exposure !== 'mixed' || pos.coDisplayGroup === undefined) {
        return {
          ok: false,
          error: 'slot singleton size is only allowed for a coDisplayGroup in mixed exposure',
        };
      }
      if (!hasWidth || !hasHeight) {
        return {
          ok: false,
          error: 'slot singleton size requires slot.width and slot.height',
        };
      }
      if (
        typeof s.singletonWidth !== 'number' ||
        typeof s.singletonHeight !== 'number' ||
        !Number.isInteger(s.singletonWidth) ||
        !Number.isInteger(s.singletonHeight) ||
        s.singletonWidth <= 0 ||
        s.singletonHeight <= 0 ||
        s.singletonWidth > MAX_SLOT_DIMENSION ||
        s.singletonHeight > MAX_SLOT_DIMENSION
      ) {
        return {
          ok: false,
          error: `slot.singletonWidth and slot.singletonHeight must be positive integers up to ${MAX_SLOT_DIMENSION}`,
        };
      }
      pos.singletonWidth = s.singletonWidth;
      pos.singletonHeight = s.singletonHeight;
    }
    slots.push(pos);
  }
  if (exposure === 'mixed' && !hasMixedGroup) {
    return { ok: false, error: 'mixed exposure requires at least one slot group' };
  }
  const params: AuctionParams = { slots, exposure };

  if (b.page !== undefined) {
    if (typeof b.page !== 'string') return { ok: false, error: 'page must be a string' };
    params.page = b.page;
  }
  if (b.userId !== undefined) {
    if (typeof b.userId !== 'string') return { ok: false, error: 'userId must be a string' };
    params.userId = b.userId;
  }
  if (b.authenticated !== undefined) {
    if (typeof b.authenticated !== 'boolean') return { ok: false, error: 'authenticated must be a boolean' };
    params.authenticated = b.authenticated;
  }
  return { ok: true, params };
}

export type FeedFillValidationResult =
  | { ok: true; params: FeedFillParams }
  | { ok: false; error: string };

/** Validates POST /feed-fill: a positive-integer `count` (clamped to MAX_FILL),
 *  optional page / userId / authenticated / format / freqCap. */
export function validateFeedFillParams(body: unknown): FeedFillValidationResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.count !== 'number' || !Number.isInteger(b.count) || b.count <= 0) {
    return { ok: false, error: 'count must be a positive integer' };
  }
  // One slow page must not allocate thousands of positions.
  const MAX_FILL = 200;
  const params: FeedFillParams = { count: Math.min(b.count, MAX_FILL) };

  if (b.page !== undefined) {
    if (typeof b.page !== 'string') return { ok: false, error: 'page must be a string' };
    params.page = b.page;
  }
  if (b.userId !== undefined) {
    if (typeof b.userId !== 'string') return { ok: false, error: 'userId must be a string' };
    params.userId = b.userId;
  }
  if (b.authenticated !== undefined) {
    if (typeof b.authenticated !== 'boolean') return { ok: false, error: 'authenticated must be a boolean' };
    params.authenticated = b.authenticated;
  }
  if (b.format !== undefined) {
    if (typeof b.format !== 'string') return { ok: false, error: 'format must be a string' };
    params.format = b.format;
  }
  if (b.freqCap !== undefined) {
    if (typeof b.freqCap !== 'number' || !Number.isInteger(b.freqCap) || b.freqCap <= 0) {
      return { ok: false, error: 'freqCap must be a positive integer' };
    }
    params.freqCap = b.freqCap;
  }
  return { ok: true, params };
}
