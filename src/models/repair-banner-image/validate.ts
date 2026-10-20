import {
  parseBannerImageDraft,
  parseBannerImageTarget,
  parseCtaPosition,
} from '../enhance-banner-image/validate';
import {
  REPAIR_FIXES,
  REPAIR_MODES,
  type BannerZone,
  type RepairBannerImageParams,
  type RepairFix,
  type RepairMode,
} from './types';

export type ValidationResult =
  | { ok: true; params: RepairBannerImageParams }
  | { ok: false; error: string };

export const NOTES_MAX_LENGTH = 1500;
/** Сколько раз подряд модератор может попросить «ещё вариант» одного запроса. */
export const VARIANT_MAX = 20;

/** Допуск на сумму долей: 0.1 + 0.9 в double чуть больше единицы. */
const EPS = 1e-6;
/** Безопасная зона уже 20 % — это не «зона», а ошибка в настройке места. */
const SAFE_AREA_MIN_SIDE = 0.2;

/** Указания модератора идут в промпт дословно, поэтому чистим только то, что
 *  модель могла бы принять за разметку или нарисовать:
 *   - управляющие символы и невидимые (\p{Cf}: мягкий перенос — модель
 *     рисовала бы дефис, нулевой пробел, BOM, смена направления текста);
 *   - переводы строки оставляем (списки правок), но \r\n, одиночный \r и
 *     разделители строк U+2028/2029 сводим к \n, а пустые строки схлопываем:
 *     в промпте пустая строка разделяет блоки, и абзац указаний слился бы со
 *     следующим блоком;
 *   - табуляцию и любые пробелы (неразрывный, узкий) — к одному обычному,
 *     чтобы не склеить слова. */
export function cleanNotes(raw: string): string {
  return raw
    .replace(/\r\n?|[\u2028\u2029]/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, '')
    .replace(/\p{Cf}/gu, '')
    .replace(/\p{Zs}+/gu, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** null от сайта — то же, что «поле не передано»: сериализатор отдаёт пустое
 *  поле как null, и 400 за это — лишняя поломка интеграции. */
function given(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function parseZone(
  raw: unknown,
  field: string,
  sideOk: (v: number) => boolean,
  sideRule: string,
): { ok: true; value: BannerZone } | { ok: false; error: string } {
  const error = `${field} must be {x,y,w,h} fractions of the output: x,y ≥ 0, w,h ${sideRule}, x+w ≤ 1, y+h ≤ 1`;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, error };
  const z = raw as Record<string, unknown>;
  const { x, y, w, h } = z;
  if (![x, y, w, h].every((v) => typeof v === 'number' && Number.isFinite(v))) return { ok: false, error };
  const zone = { x: x as number, y: y as number, w: w as number, h: h as number };
  if (zone.x < 0 || zone.y < 0) return { ok: false, error };
  if (!sideOk(zone.w) || !sideOk(zone.h)) return { ok: false, error };
  if (zone.x + zone.w > 1 + EPS || zone.y + zone.h > 1 + EPS) return { ok: false, error };
  return { ok: true, value: zone };
}

export function validateRepairBannerImageParams(body: unknown): ValidationResult {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const b = body as Record<string, unknown>;

  const target = parseBannerImageTarget(b);
  if (!target.ok) return target;

  if (typeof b.mode !== 'string' || !(REPAIR_MODES as readonly string[]).includes(b.mode)) {
    return { ok: false, error: 'mode must be one of careful|rebuild' };
  }
  const mode = b.mode as RepairMode;

  if (!Array.isArray(b.fixes)) {
    return { ok: false, error: `fixes must be an array of ${REPAIR_FIXES.join('|')}` };
  }
  const fixes: RepairFix[] = [];
  for (const fix of b.fixes) {
    if (typeof fix !== 'string' || !(REPAIR_FIXES as readonly string[]).includes(fix)) {
      return { ok: false, error: `unknown fix: ${String(fix)} (allowed: ${REPAIR_FIXES.join('|')})` };
    }
    if (fixes.includes(fix as RepairFix)) {
      return { ok: false, error: `duplicate fix: ${fix}` };
    }
    fixes.push(fix as RepairFix);
  }

  let notes: string | undefined;
  if (given(b.notes)) {
    if (typeof b.notes !== 'string') return { ok: false, error: 'notes must be a string' };
    const cleaned = cleanNotes(b.notes);
    if (cleaned.length > NOTES_MAX_LENGTH) {
      return { ok: false, error: `notes too long (max ${NOTES_MAX_LENGTH} chars)` };
    }
    notes = cleaned || undefined;
  }

  let safeArea: BannerZone | undefined;
  if (given(b.safeArea)) {
    const parsed = parseZone(b.safeArea, 'safeArea', (v) => v >= SAFE_AREA_MIN_SIDE && v <= 1, 'in [0.2, 1]');
    if (!parsed.ok) return parsed;
    safeArea = parsed.value;
  }
  let reservedZone: BannerZone | undefined;
  if (given(b.reservedZone)) {
    const parsed = parseZone(b.reservedZone, 'reservedZone', (v) => v > 0 && v <= 1, 'in (0, 1]');
    if (!parsed.ok) return parsed;
    reservedZone = parsed.value;
  }

  // careful черновик не использует (см. prompt.ts) — без него это {}; в
  // rebuild пустой черновик дальше отсекает проверка заголовка.
  const draft: ReturnType<typeof parseBannerImageDraft> = given(b.draft)
    ? parseBannerImageDraft(b.draft)
    : { ok: true, value: {} };
  if (!draft.ok) return draft;

  const ctaPosition = parseCtaPosition(given(b.ctaPosition) ? b.ctaPosition : undefined);
  if (!ctaPosition.ok) return ctaPosition;

  let variant: number | undefined;
  if (given(b.variant)) {
    if (typeof b.variant !== 'number' || !Number.isInteger(b.variant) || b.variant < 0 || b.variant > VARIANT_MAX) {
      return { ok: false, error: `variant must be an integer 0..${VARIANT_MAX}` };
    }
    variant = b.variant;
  }

  // Правка без своих данных выродилась бы в «сделай как-нибудь»: цифры зон
  // берутся только из запроса, а пропавшие слова — только из указаний.
  if (fixes.includes('fit_safe_area') && !safeArea) {
    return { ok: false, error: 'fit_safe_area requires safeArea' };
  }
  if (fixes.includes('free_overlay_zone') && !reservedZone) {
    return { ok: false, error: 'free_overlay_zone requires reservedZone' };
  }
  if (fixes.includes('restore_text') && !notes) {
    return { ok: false, error: 'restore_text requires notes with the full wording' };
  }
  if (fixes.length === 0 && !notes) {
    return { ok: false, error: 'nothing to do: select at least one fix or write notes' };
  }
  // rebuild — это enhance: без заголовка или описания модели нечего писать,
  // а пайплайну нечего сверять. actionLabel не в счёт: его рисует витрина.
  if (mode === 'rebuild') {
    const hasHeadline =
      (draft.value.title ?? '').trim() !== '' || (draft.value.description ?? '').trim() !== '';
    if (!hasHeadline) {
      return { ok: false, error: 'rebuild mode requires draft.title or draft.description' };
    }
  }

  return {
    ok: true,
    params: {
      ...target.value,
      advertiserId: target.value.advertiserId.trim(),
      mode,
      fixes,
      notes,
      safeArea,
      reservedZone,
      draft: draft.value,
      ctaPosition: ctaPosition.value,
      ...(variant ? { variant } : {}),
    },
  };
}
