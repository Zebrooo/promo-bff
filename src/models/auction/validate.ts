import type { AuctionParams, AuctionPositionParam } from './types';

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
  const slots: AuctionPositionParam[] = [];
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
    slots.push(pos);
  }
  const params: AuctionParams = { slots };

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
