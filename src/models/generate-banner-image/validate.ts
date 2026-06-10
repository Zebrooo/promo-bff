import type { GenerateBannerImageParams } from './types';

export type ValidationResult =
  | { ok: true; params: GenerateBannerImageParams }
  | { ok: false; error: string };

export function validateGenerateBannerImageParams(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.advertiserId !== 'string' || b.advertiserId.trim() === '') {
    return { ok: false, error: 'advertiserId must be a non-empty string' };
  }
  if (typeof b.prompt !== 'string' || b.prompt.trim().length < 4) {
    return { ok: false, error: 'prompt must be a non-empty string (≥ 4 chars)' };
  }
  if (b.prompt.length > 2000) {
    return { ok: false, error: 'prompt too long (max 2000 chars)' };
  }
  if (typeof b.width !== 'number' || !Number.isInteger(b.width) || b.width <= 0 || b.width > 4096) {
    return { ok: false, error: 'width must be a positive integer ≤ 4096' };
  }
  if (typeof b.height !== 'number' || !Number.isInteger(b.height) || b.height <= 0 || b.height > 4096) {
    return { ok: false, error: 'height must be a positive integer ≤ 4096' };
  }

  return {
    ok: true,
    params: {
      advertiserId: b.advertiserId.trim(),
      prompt:       b.prompt.trim(),
      width:        b.width,
      height:       b.height,
    },
  };
}
