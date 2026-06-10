import type { EnhanceBannerImageParams } from './types';

export type ValidationResult =
  | { ok: true; params: EnhanceBannerImageParams }
  | { ok: false; error: string };

const HTTP = /^https?:\/\//i;
const DATA_URL = /^data:image\//i;
const CTA_POSITIONS = ['tl', 'tr', 'bl', 'br'] as const;

export function validateEnhanceBannerImageParams(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;

  if (typeof b.advertiserId !== 'string' || b.advertiserId.trim() === '') {
    return { ok: false, error: 'advertiserId must be a non-empty string' };
  }
  if (typeof b.imageUrl !== 'string' || (!HTTP.test(b.imageUrl) && !DATA_URL.test(b.imageUrl))) {
    return { ok: false, error: 'imageUrl must be an http(s):// URL or a data:image/… data URL' };
  }
  if (typeof b.width !== 'number' || !Number.isInteger(b.width) || b.width <= 0 || b.width > 4096) {
    return { ok: false, error: 'width must be a positive integer ≤ 4096' };
  }
  if (typeof b.height !== 'number' || !Number.isInteger(b.height) || b.height <= 0 || b.height > 4096) {
    return { ok: false, error: 'height must be a positive integer ≤ 4096' };
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
  if (draft.actionLabel !== undefined && typeof draft.actionLabel !== 'string') {
    return { ok: false, error: 'draft.actionLabel must be a string' };
  }
  // At least one text field — otherwise there's nothing for the model to render
  // (we still want the image regenerated, but giving it text is the whole point).
  const hasText =
    (typeof draft.title === 'string' && draft.title.trim() !== '') ||
    (typeof draft.description === 'string' && draft.description.trim() !== '') ||
    (typeof draft.actionLabel === 'string' && draft.actionLabel.trim() !== '');
  if (!hasText) {
    return { ok: false, error: 'draft must contain at least one non-empty text field' };
  }

  let ctaPosition: string | undefined;
  if (b.ctaPosition !== undefined) {
    if (typeof b.ctaPosition !== 'string' || !(CTA_POSITIONS as readonly string[]).includes(b.ctaPosition)) {
      return { ok: false, error: 'ctaPosition must be one of tl|tr|bl|br' };
    }
    ctaPosition = b.ctaPosition;
  }

  return {
    ok: true,
    params: {
      advertiserId: b.advertiserId,
      imageUrl: b.imageUrl,
      width: b.width,
      height: b.height,
      draft: {
        title: typeof draft.title === 'string' ? draft.title : undefined,
        description: typeof draft.description === 'string' ? draft.description : undefined,
        actionLabel: typeof draft.actionLabel === 'string' ? draft.actionLabel : undefined,
      },
      ctaPosition,
    },
  };
}
