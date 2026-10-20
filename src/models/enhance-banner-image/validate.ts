import type { BannerImageDraft, EnhanceBannerImageParams } from './types';

export type ValidationResult =
  | { ok: true; params: EnhanceBannerImageParams }
  | { ok: false; error: string };

const HTTP = /^https?:\/\//i;
const DATA_URL = /^data:image\//i;
const CTA_POSITIONS = ['tl', 'tr', 'bl', 'br'] as const;

/** Общие поля картинки-по-референсу: кто платит, что за референс и какой
 *  размер нужен. Их же проверяет /repair-banner-image — правила одни. */
export interface BannerImageTarget {
  advertiserId: string;
  imageUrl: string;
  width: number;
  height: number;
}

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

export function parseBannerImageTarget(b: Record<string, unknown>): Parsed<BannerImageTarget> {
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
  // Ключ лимита и учёта расходов — без случайных пробелов, одинаково у всех
  // ручек картинок (generate-banner-image тоже обрезает).
  return { ok: true, value: { advertiserId: b.advertiserId.trim(), imageUrl: b.imageUrl, width: b.width, height: b.height } };
}

/** Форма draft без требований к содержимому: что обязательно — решает ручка. */
export function parseBannerImageDraft(raw: unknown): Parsed<BannerImageDraft> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'draft must be an object' };
  }
  const draft = raw as Record<string, unknown>;
  if (draft.title !== undefined && typeof draft.title !== 'string') {
    return { ok: false, error: 'draft.title must be a string' };
  }
  if (draft.description !== undefined && typeof draft.description !== 'string') {
    return { ok: false, error: 'draft.description must be a string' };
  }
  if (draft.actionLabel !== undefined && typeof draft.actionLabel !== 'string') {
    return { ok: false, error: 'draft.actionLabel must be a string' };
  }
  return {
    ok: true,
    value: {
      title: typeof draft.title === 'string' ? draft.title : undefined,
      description: typeof draft.description === 'string' ? draft.description : undefined,
      actionLabel: typeof draft.actionLabel === 'string' ? draft.actionLabel : undefined,
    },
  };
}

export function parseCtaPosition(raw: unknown): Parsed<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined };
  if (typeof raw !== 'string' || !(CTA_POSITIONS as readonly string[]).includes(raw)) {
    return { ok: false, error: 'ctaPosition must be one of tl|tr|bl|br' };
  }
  return { ok: true, value: raw };
}

export function validateEnhanceBannerImageParams(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;

  const target = parseBannerImageTarget(b);
  if (!target.ok) return target;
  const draft = parseBannerImageDraft(b.draft);
  if (!draft.ok) return draft;
  // At least one text field — otherwise there's nothing for the model to render
  // (we still want the image regenerated, but giving it text is the whole point).
  const hasText =
    (typeof draft.value.title === 'string' && draft.value.title.trim() !== '') ||
    (typeof draft.value.description === 'string' && draft.value.description.trim() !== '') ||
    (typeof draft.value.actionLabel === 'string' && draft.value.actionLabel.trim() !== '');
  if (!hasText) {
    return { ok: false, error: 'draft must contain at least one non-empty text field' };
  }

  const ctaPosition = parseCtaPosition(b.ctaPosition);
  if (!ctaPosition.ok) return ctaPosition;

  return {
    ok: true,
    params: {
      ...target.value,
      draft: draft.value,
      ctaPosition: ctaPosition.value,
    },
  };
}
