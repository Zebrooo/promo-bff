import { describe, it, expect } from 'vitest';
import { NOTES_MAX_LENGTH, validateRepairBannerImageParams } from './validate';

/** Минимальное валидное тело careful-режима. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    advertiserId: 'mod:42',
    imageUrl: 'https://example.com/banner.png',
    width: 600,
    height: 750,
    mode: 'careful',
    fixes: ['contrast'],
    draft: {},
    ...over,
  };
}

function errorOf(b: unknown): string {
  const result = validateRepairBannerImageParams(b);
  if (result.ok) throw new Error('expected a validation error');
  return result.error;
}

describe('validateRepairBannerImageParams — общие поля (как у enhance)', () => {
  it('тело не объект', () => {
    expect(errorOf(null)).toMatch(/body must be an object/);
    expect(errorOf([])).toMatch(/body must be an object/);
  });

  it('пустой advertiserId', () => {
    expect(errorOf(body({ advertiserId: '  ' }))).toMatch(/advertiserId/);
  });

  it('imageUrl не http(s) и не data:image', () => {
    expect(errorOf(body({ imageUrl: 'ftp://example.com/x.png' }))).toMatch(/imageUrl/);
    expect(errorOf(body({ imageUrl: 'data:text/html,hi' }))).toMatch(/imageUrl/);
  });

  it('ширина и высота — целые 1..4096', () => {
    expect(errorOf(body({ width: 0 }))).toMatch(/width/);
    expect(errorOf(body({ width: 600.5 }))).toMatch(/width/);
    expect(errorOf(body({ height: 4097 }))).toMatch(/height/);
  });

  it('draft не объект или поле не строка', () => {
    expect(errorOf(body({ draft: 'Заголовок' }))).toMatch(/draft must be an object/);
    expect(errorOf(body({ draft: { title: 5 } }))).toMatch(/draft.title/);
  });

  it('draft: careful его не использует — без него {}; rebuild без него — нет заголовка', () => {
    for (const draft of [undefined, null]) {
      const result = validateRepairBannerImageParams(body({ draft }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.params.draft).toEqual({});
      expect(errorOf(body({ mode: 'rebuild', draft }))).toMatch(/rebuild mode requires draft.title or draft.description/);
    }
  });

  it('null в необязательных полях — как будто поля нет', () => {
    const result = validateRepairBannerImageParams(body({
      notes: null, safeArea: null, reservedZone: null, ctaPosition: null,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params.notes).toBeUndefined();
    expect(result.params.safeArea).toBeUndefined();
    expect(result.params.reservedZone).toBeUndefined();
    expect(result.params.ctaPosition).toBeUndefined();
    // null на месте зоны правку не удовлетворяет.
    expect(errorOf(body({ fixes: ['fit_safe_area'], safeArea: null }))).toMatch(/fit_safe_area requires safeArea/);
  });

  it('ctaPosition вне tl|tr|bl|br', () => {
    expect(errorOf(body({ ctaPosition: 'center' }))).toMatch(/ctaPosition/);
  });
});

describe('validateRepairBannerImageParams — режим и правки', () => {
  it('mode обязателен и только careful|rebuild', () => {
    expect(errorOf(body({ mode: undefined }))).toMatch(/mode/);
    expect(errorOf(body({ mode: 'redraw' }))).toMatch(/mode/);
  });

  it('fixes — массив', () => {
    expect(errorOf(body({ fixes: 'contrast' }))).toMatch(/fixes must be an array/);
    expect(errorOf(body({ fixes: undefined }))).toMatch(/fixes must be an array/);
  });

  it('неизвестная правка → 400', () => {
    expect(errorOf(body({ fixes: ['contrast', 'make_it_pop'] }))).toMatch(/unknown fix: make_it_pop/);
    expect(errorOf(body({ fixes: [1] }))).toMatch(/unknown fix/);
  });

  it('повтор правки → 400', () => {
    expect(errorOf(body({ fixes: ['contrast', 'contrast'] }))).toMatch(/duplicate fix: contrast/);
  });

  it('ни правок, ни указаний — делать нечего', () => {
    expect(errorOf(body({ fixes: [] }))).toMatch(/nothing to do/);
    expect(errorOf(body({ fixes: [], notes: ' \n\t ' }))).toMatch(/nothing to do/);
  });

  it('fit_safe_area без safeArea', () => {
    expect(errorOf(body({ fixes: ['fit_safe_area'] }))).toMatch(/fit_safe_area requires safeArea/);
  });

  it('free_overlay_zone без reservedZone', () => {
    expect(errorOf(body({ fixes: ['free_overlay_zone'] }))).toMatch(/free_overlay_zone requires reservedZone/);
  });

  it('restore_text без указаний (или с пустыми) — формулировку даёт только модератор', () => {
    expect(errorOf(body({ fixes: ['restore_text'] }))).toMatch(/restore_text requires notes/);
    expect(errorOf(body({ fixes: ['restore_text'], notes: '   ' }))).toMatch(/restore_text requires notes/);
  });

  it('rebuild без заголовка и описания → 400; одного actionLabel мало', () => {
    expect(errorOf(body({ mode: 'rebuild', draft: {} }))).toMatch(/rebuild mode requires draft.title or draft.description/);
    expect(errorOf(body({ mode: 'rebuild', draft: { title: '  ', actionLabel: 'Позвонить' } })))
      .toMatch(/rebuild mode requires/);
  });
});

describe('validateRepairBannerImageParams — указания модератора', () => {
  it('notes — строка', () => {
    expect(errorOf(body({ notes: 42 }))).toMatch(/notes must be a string/);
  });

  it('длиннее 1500 символов после очистки → 400, ровно 1500 — можно', () => {
    expect(errorOf(body({ notes: 'а'.repeat(NOTES_MAX_LENGTH + 1) }))).toMatch(/notes too long/);
    const ok = validateRepairBannerImageParams(body({ notes: 'а'.repeat(NOTES_MAX_LENGTH) }));
    expect(ok.ok).toBe(true);
    // Управляющие символы в лимит не идут — они вырезаются до проверки.
    const padded = validateRepairBannerImageParams(body({ notes: 'а'.repeat(NOTES_MAX_LENGTH) + '\u0000\u0007' }));
    expect(padded.ok).toBe(true);
  });

  it('обрезаются пробелы, вырезаются управляющие символы, перевод строки остаётся', () => {
    const result = validateRepairBannerImageParams(body({
      notes: '  Номер\u0000 не меняй.\r\nТелефон\tкрупнее\u001b\u007f\n ',
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.notes).toBe('Номер не меняй.\nТелефон крупнее');
  });

  it('невидимые символы вырезаются, пробелы и пустые строки схлопываются', () => {
    const result = validateRepairBannerImageParams(body({
      // мягкий перенос, нулевой пробел, BOM, смена направления, разделитель
      // строк, неразрывный и узкий пробелы, пустая строка между абзацами
      notes: '\uFEFFТеле\u00ADфон\u200B крупнее.\u202E\u2028\u2028Номер\u00A0\u202F WhatsApp   не меняй. \n\n\n  Логотип не трогай.',
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.notes).toBe('Телефон крупнее.\nНомер WhatsApp не меняй.\nЛоготип не трогай.');
  });

  it('пустые после очистки указания — как будто их нет', () => {
    const result = validateRepairBannerImageParams(body({ notes: '\u0000  \n' }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.notes).toBeUndefined();
  });
});

describe('validateRepairBannerImageParams — зоны', () => {
  const safe = { x: 0, y: 0.1, w: 1, h: 0.8 };
  const reserved = { x: 0.1, y: 0.6, w: 0.9, h: 0.4 };

  it('safeArea: не объект, не числа, бесконечность', () => {
    expect(errorOf(body({ safeArea: [0, 0, 1, 1] }))).toMatch(/safeArea must be/);
    expect(errorOf(body({ safeArea: { ...safe, w: '1' } }))).toMatch(/safeArea must be/);
    expect(errorOf(body({ safeArea: { ...safe, h: Number.POSITIVE_INFINITY } }))).toMatch(/safeArea must be/);
    expect(errorOf(body({ safeArea: { x: 0, y: 0, w: 1 } }))).toMatch(/safeArea must be/);
  });

  it('safeArea: отрицательное начало, сторона вне [0.2, 1], выход за край', () => {
    expect(errorOf(body({ safeArea: { ...safe, x: -0.01 } }))).toMatch(/safeArea/);
    expect(errorOf(body({ safeArea: { ...safe, w: 0.19 } }))).toMatch(/safeArea/);
    expect(errorOf(body({ safeArea: { ...safe, h: 1.01, y: 0 } }))).toMatch(/safeArea/);
    expect(errorOf(body({ safeArea: { x: 0.5, y: 0, w: 0.6, h: 1 } }))).toMatch(/safeArea/);
    expect(errorOf(body({ safeArea: { x: 0, y: 0.3, w: 1, h: 0.7 + 1e-5 } }))).toMatch(/safeArea/);
  });

  it('safeArea: сторона ровно 0.2 и погрешность double на сумме — можно', () => {
    expect(validateRepairBannerImageParams(body({ safeArea: { x: 0.8, y: 0, w: 0.2, h: 1 } })).ok).toBe(true);
    expect(validateRepairBannerImageParams(body({ safeArea: { x: 0.3, y: 0, w: 0.7 + 1e-7, h: 1 } })).ok).toBe(true);
  });

  it('reservedZone: сторона в (0, 1] — узкая можно, нулевая и больше единицы нельзя', () => {
    expect(validateRepairBannerImageParams(body({ reservedZone: { x: 0, y: 0.9, w: 1, h: 0.05 } })).ok).toBe(true);
    expect(errorOf(body({ reservedZone: { ...reserved, w: 0 } }))).toMatch(/reservedZone must be/);
    expect(errorOf(body({ reservedZone: { x: 0, y: 0, w: 1.5, h: 0.4 } }))).toMatch(/reservedZone/);
    expect(errorOf(body({ reservedZone: { ...reserved, y: -0.1 } }))).toMatch(/reservedZone/);
    expect(errorOf(body({ reservedZone: { ...reserved, x: 0.2 } }))).toMatch(/reservedZone/);
  });
});

describe('validateRepairBannerImageParams — успешные тела', () => {
  it('careful со всеми правками, зонами и указаниями', () => {
    const result = validateRepairBannerImageParams(body({
      advertiserId: '  mod:42  ',
      fixes: ['clean_background', 'fit_safe_area', 'free_overlay_zone', 'restore_text', 'contrast', 'drop_small_text'],
      notes: 'Нижняя надпись обрезана.',
      safeArea: { x: 0, y: 0.1, w: 1, h: 0.8, extra: true },
      reservedZone: { x: 0.1, y: 0.6, w: 0.9, h: 0.4 },
      draft: { title: 'Мастерская' },
      ctaPosition: 'bl',
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.params).toEqual({
      advertiserId: 'mod:42',
      imageUrl: 'https://example.com/banner.png',
      width: 600,
      height: 750,
      mode: 'careful',
      fixes: ['clean_background', 'fit_safe_area', 'free_overlay_zone', 'restore_text', 'contrast', 'drop_small_text'],
      notes: 'Нижняя надпись обрезана.',
      // Лишние ключи зоны не протекают дальше (они попали бы в ключ кэша).
      safeArea: { x: 0, y: 0.1, w: 1, h: 0.8 },
      reservedZone: { x: 0.1, y: 0.6, w: 0.9, h: 0.4 },
      draft: { title: 'Мастерская', description: undefined, actionLabel: undefined },
      ctaPosition: 'bl',
    });
  });

  it('careful только с указаниями, без правок и без текста в draft', () => {
    const result = validateRepairBannerImageParams(body({ fixes: [], notes: 'Сделай телефон крупнее' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.fixes).toEqual([]);
      expect(result.params.notes).toBe('Сделай телефон крупнее');
    }
  });

  it('rebuild с описанием вместо заголовка и data:image референсом', () => {
    const result = validateRepairBannerImageParams(body({
      mode: 'rebuild',
      imageUrl: 'data:image/png;base64,AAAA',
      fixes: ['contrast'],
      draft: { description: 'Шиномонтаж 24/7' },
    }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.mode).toBe('rebuild');
  });
});

describe('validateRepairBannerImageParams — номер варианта', () => {
  it('целое 0..20; ноль и пропуск — одно и то же (в параметры не попадает)', () => {
    const ok = validateRepairBannerImageParams(body({ variant: 3 }));
    expect(ok.ok && ok.params.variant).toBe(3);
    const zero = validateRepairBannerImageParams(body({ variant: 0 }));
    expect(zero.ok && 'variant' in zero.params).toBe(false);
    expect(errorOf(body({ variant: 21 }))).toMatch(/variant/);
    expect(errorOf(body({ variant: 1.5 }))).toMatch(/variant/);
    expect(errorOf(body({ variant: '2' }))).toMatch(/variant/);
  });
});
