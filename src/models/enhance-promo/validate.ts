/** Validation for POST /enhance-promo body. Plain TS (no zod) — same style as
 *  models/auction/validate.ts. The validator narrows draft to the fields we
 *  actually act on (title/description/action.label); other keys are passed
 *  through opaquely as `unknown` via the PromoDraft index signature. */
import type { AvailablePage, EnhanceParams, PromoDraft } from './types';

export type ValidationResult =
  | { ok: true; params: EnhanceParams }
  | { ok: false; error: string };

export function validateEnhanceParams(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.advertiserId !== 'string' || b.advertiserId.trim() === '') {
    return { ok: false, error: 'advertiserId must be a non-empty string' };
  }

  if (typeof b.draft !== 'object' || b.draft === null || Array.isArray(b.draft)) {
    return { ok: false, error: 'draft must be an object' };
  }
  const draft = b.draft as Record<string, unknown>;

  if (draft.title !== undefined && typeof draft.title !== 'string') {
    return { ok: false, error: 'draft.title must be a string' };
  }
  if (draft.description !== undefined && typeof draft.description !== 'string') {
    return { ok: false, error: 'draft.description must be a string' };
  }
  let actionLabel: string | undefined;
  if (draft.action !== undefined) {
    if (typeof draft.action !== 'object' || draft.action === null || Array.isArray(draft.action)) {
      return { ok: false, error: 'draft.action must be an object' };
    }
    const a = draft.action as Record<string, unknown>;
    if (a.label !== undefined && typeof a.label !== 'string') {
      return { ok: false, error: 'draft.action.label must be a string' };
    }
    if (a.href !== undefined && typeof a.href !== 'string') {
      return { ok: false, error: 'draft.action.href must be a string' };
    }
    actionLabel = typeof a.label === 'string' ? a.label : undefined;
  }

  // The model has nothing to improve if every text field is empty.
  const hasText =
    (typeof draft.title === 'string' && draft.title.trim() !== '') ||
    (typeof draft.description === 'string' && draft.description.trim() !== '') ||
    (typeof actionLabel === 'string' && actionLabel.trim() !== '');
  if (!hasText) {
    return {
      ok: false,
      error: 'draft must contain at least one non-empty text field (title, description, or action.label)',
    };
  }

  // availablePages is optional (back-compat for promo-cabinet).
  let availablePages: AvailablePage[] | undefined;
  if (b.availablePages !== undefined) {
    if (!Array.isArray(b.availablePages)) {
      return { ok: false, error: 'availablePages must be an array' };
    }
    const parsed: AvailablePage[] = [];
    for (const item of b.availablePages) {
      if (typeof item !== 'object' || item === null || Array.isArray(item)) {
        return { ok: false, error: 'availablePages items must be objects' };
      }
      const it = item as Record<string, unknown>;
      if (typeof it.key !== 'string' || it.key.trim() === '') {
        return { ok: false, error: 'availablePages items must have non-empty string key' };
      }
      if (typeof it.name !== 'string' || it.name.trim() === '') {
        return { ok: false, error: 'availablePages items must have non-empty string name' };
      }
      parsed.push({ key: it.key, name: it.name });
    }
    availablePages = parsed;
  }

  return {
    ok: true,
    params: { advertiserId: b.advertiserId, draft: draft as PromoDraft, availablePages },
  };
}

/** Whitelist filter for AI-suggested page keys. Drops anything not in `allowed`,
 *  dedupes, preserves order of first occurrence. */
export function filterPagesAgainstWhitelist(
  keys: readonly string[],
  allowed: readonly AvailablePage[],
): string[] {
  const allowedSet = new Set(allowed.map((p) => p.key));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (!allowedSet.has(k)) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** Range gate for AI-suggested CPM value in roubles. Inclusive [1, 500].
 *  Расширен с [1, 50] после bootstrap-калибровки на половину Я.Директа. */
export function validateCpmRange(value: number): boolean {
  return Number.isFinite(value) && value >= 1 && value <= 500;
}
