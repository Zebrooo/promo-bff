import { describe, it, expect } from 'vitest';
import { buildEnhanceBannerImagePrompt } from '../enhance-banner-image/prompt';
import { buildRepairBannerImagePrompt } from './prompt';
import { REPAIR_FIXES, type RepairBannerImageParams, type RepairFix } from './types';

const NOTES = 'Нижняя надпись обрезана. Полностью: «Создаём уникальные вещи, которых нет больше нигде». Номер WhatsApp не меняй.';

function params(over: Partial<RepairBannerImageParams> = {}): RepairBannerImageParams {
  return {
    advertiserId: 'mod:42',
    imageUrl: 'https://example.com/banner.png',
    width: 600,
    height: 750,
    mode: 'careful',
    fixes: [...REPAIR_FIXES],
    notes: NOTES,
    safeArea: { x: 0, y: 0.1, w: 1, h: 0.8 },
    reservedZone: { x: 0.1, y: 0.6, w: 0.9, h: 0.4 },
    draft: {},
    ...over,
  };
}

/** Узнаваемое начало строки каждой правки в careful-промпте. */
const FIX_MARKERS: Record<RepairFix, string> = {
  fit_safe_area: '- Fit everything into the safe area',
  free_overlay_zone: '- Keep the area from',
  restore_text: '- Restore cut-off text',
  contrast: '- Readability:',
  drop_small_text: '- Remove small print',
  clean_background: '- Clean the background',
};

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('buildRepairBannerImagePrompt — careful', () => {
  it('правим присланный баннер, а не рисуем новый; форма кадра названа', () => {
    const prompt = buildRepairBannerImagePrompt(params());
    expect(prompt).toContain('Edit the attached display-ad banner');
    expect(prompt).toContain('a vertical poster, aspect ratio 4:5 (600×750 px, taller than wide)');
    expect(prompt).toContain('do not redesign it or start from scratch');
    expect(prompt).toContain('the image is 4:5.');
  });

  it('KEEP: фото, цвета, логотип, весь текст и контакты дословно', () => {
    const prompt = buildRepairBannerImagePrompt(params());
    expect(prompt).toContain('KEEP — exactly as in the reference, unless a change under CHANGE ONLY or the moderator notes below say otherwise:');
    expect(prompt).toContain('- The photo and the subject');
    expect(prompt).toContain('- The colours and the overall style');
    expect(prompt).toContain('- The logo and any brand marks, exactly as they appear.');
    expect(prompt).toContain('letter for letter and digit for digit');
  });

  it('в CHANGE ONLY только выбранные правки', () => {
    for (const fix of REPAIR_FIXES) {
      const prompt = buildRepairBannerImagePrompt(params({ fixes: [fix] }));
      for (const other of REPAIR_FIXES) {
        expect(prompt.includes(FIX_MARKERS[other]), `${fix} → ${other}`).toBe(other === fix);
      }
    }
  });

  it('порядок правок в запросе на промпт не влияет', () => {
    const forward = buildRepairBannerImagePrompt(params());
    const backward = buildRepairBannerImagePrompt(params({ fixes: [...REPAIR_FIXES].reverse() }));
    expect(backward).toBe(forward);
  });

  it('проценты считаются из долей зон (кадр модели той же формы, что файл)', () => {
    const prompt = buildRepairBannerImagePrompt(params());
    expect(prompt).toContain('inside the area from 0 % to 100 % across and from 10 % to 90 % down');
    expect(prompt).toContain('Keep the area from 10 % to 100 % across and from 60 % to 100 % down free');
    const odd = buildRepairBannerImagePrompt(params({
      fixes: ['fit_safe_area'],
      safeArea: { x: 0.125, y: 0, w: 0.75, h: 1 / 3 },
    }));
    expect(odd).toContain('from 12.5 % to 87.5 % across and from 0 % to 33.3 % down');
  });

  it('полоса 1160×240: зоны переведены в кадр 4:1 — по высоте его середина 82,8 %, срез по 8,6 % сверху и снизу', () => {
    const prompt = buildRepairBannerImagePrompt(params({ width: 1160, height: 240 }));
    // y' = 0,0862 + y × 0,8276; по ширине кадр не срезается.
    expect(prompt).toContain('inside the area from 0 % to 100 % across and from 16.9 % to 83.1 % down');
    expect(prompt).toContain('Keep the area from 10 % to 100 % across and from 58.3 % to 91.4 % down free');
    // Запас от срезаемых краёв: 8,6 % среза + 2 % на глаз модели → 11 %.
    expect(prompt).toContain('Keep all text, the logo and the key details of the subject at least 11 % of the height away from the top and bottom edges');
    expect(prompt).toContain('all text, the logo and key details are at least 11 % of the height away from the top and bottom edges');
  });

  it('запас от краёв — только при заметном срезе и по срезаемой оси', () => {
    expect(buildRepairBannerImagePrompt(params())).not.toContain('away from the');
    // 600×1000 → 9:16, срез 3,125 % с каждой стороны → 6 %.
    expect(buildRepairBannerImagePrompt(params({ width: 600, height: 1000 })))
      .toContain('at least 6 % of the height away from the top and bottom edges');
    // 1000×1100 → 1:1, кадр шире слота — режутся бока.
    expect(buildRepairBannerImagePrompt(params({ width: 1000, height: 1100, fixes: ['contrast'] })))
      .toContain('at least 7 % of the width away from the left and right edges');
  });

  it('сильно другая форма — переложить элементы, пример под форму выхода', () => {
    expect(buildRepairBannerImagePrompt(params({ width: 2400, height: 300 })))
      .toContain('If the shapes differ a lot, rearrange the existing elements to suit the new shape — side by side instead of stacked — scaling each one evenly');
    expect(buildRepairBannerImagePrompt(params()))
      .toContain('to suit the new shape — stacked instead of side by side — scaling each one evenly');
    expect(buildRepairBannerImagePrompt(params({ width: 1000, height: 1000 })))
      .toContain('to suit the new shape, scaling each one evenly');
    expect(buildRepairBannerImagePrompt(params())).toContain('the general arrangement as far as the output shape allows');
  });

  it('при обеих зонах сказано прямо, что важное — в безопасной и вне занятой', () => {
    expect(buildRepairBannerImagePrompt(params())).toContain('inside the safe area and outside this area at the same time');
    expect(buildRepairBannerImagePrompt(params({ fixes: ['free_overlay_zone'] })))
      .not.toContain('inside the safe area and outside');
  });

  it('зоны без выбранной правки в промпт не попадают', () => {
    const prompt = buildRepairBannerImagePrompt(params({ fixes: ['contrast'] }));
    expect(prompt).not.toContain('% across');
    expect(prompt).not.toContain('positions are percentages');
  });

  it('указания модератора — дословно, один раз, после инструкций и с приоритетом над KEEP', () => {
    const prompt = buildRepairBannerImagePrompt(params());
    expect(count(prompt, NOTES)).toBe(1);
    // Команды, а не надпись: иначе «Номер WhatsApp не меняй» — допустимый текст для картинки.
    expect(prompt).toContain("MODERATOR NOTES — the next line holds instructions to you from the site's moderator, written in Russian; they are not text for the image. Only wording they explicitly ask to be written on the banner may appear on it.");
    expect(prompt).toContain(`where they conflict with KEEP, the notes win. Quotation marks in them only mark the exact wording and are never drawn.\n${NOTES}\n`);
    expect(prompt.indexOf('MODERATOR NOTES')).toBeGreaterThan(prompt.indexOf('RULES'));
  });

  it('число строк указаний названо в шапке блока', () => {
    const prompt = buildRepairBannerImagePrompt(params({ notes: 'Телефон крупнее.\nНомер WhatsApp не меняй.' }));
    expect(prompt).toContain('MODERATOR NOTES — the next 2 lines hold instructions');
  });

  it('жёсткие правила: ничего не выдумывать, не переводить и не исправлять, не угадывать обрезанное', () => {
    const prompt = buildRepairBannerImagePrompt(params());
    expect(prompt).toContain('Do not invent anything: no text, numbers, prices, phone numbers, discounts or claims that are not already in the reference or that the moderator notes explicitly ask to be written on the banner.');
    expect(prompt).toContain('- Never translate: all text stays in its language, every letter exactly as in the reference or in the wording the moderator notes give — do not correct spelling, including Abkhaz letters');
    expect(prompt).not.toContain('correct Cyrillic spelling');
    expect(prompt).toContain('- Never guess missing letters, words or digits of text that is cut off in the reference. Use only the wording from the moderator notes; if they do not give it in full, remove that line completely');
    expect(prompt).toContain('write each word exactly once (no word repeated across a line break)');
  });

  it('обрезанное не угадывается и без restore_text: перенос в зону тянет строку в кадр целиком', () => {
    const withNotes = buildRepairBannerImagePrompt(params({ fixes: ['fit_safe_area'] }));
    expect(withNotes).toContain('- Never guess missing letters, words or digits of text that is cut off in the reference. If such a line has to move, move only its visible part, without completing it, unless the moderator notes give its full wording.');
    expect(withNotes).not.toContain('Use only the wording from the moderator notes');
    const noNotes = buildRepairBannerImagePrompt(params({ fixes: ['fit_safe_area'], notes: undefined }));
    expect(noNotes).toContain('move only its visible part, without completing it.');
  });

  it('правки: без подложки за текстом, хвост строки не в зоне, обрезанное — без самовольного переноса', () => {
    const prompt = buildRepairBannerImagePrompt(params());
    expect(prompt).toContain('every piece of text (the logo stays as it is)');
    expect(prompt).toContain('with a broad, soft gradient that fades out gradually over a large part of the image, so no edge or shape of it can be seen');
    expect(prompt).not.toContain('right behind the text');
    expect(prompt).toContain('not even the end of a line of text');
    expect(prompt).toContain('make it slightly smaller or break it into two lines, each word written once');
    expect(prompt).toContain('scale them down evenly as much as needed, and no more');
  });

  it('финальная проверка: текст, цифры телефона, зоны, форма', () => {
    const prompt = buildRepairBannerImagePrompt(params());
    const check = prompt.slice(prompt.indexOf('Final check before you output:'));
    expect(check).toContain('every piece of text is spelled exactly as in the reference or as the moderator notes ask to write it');
    expect(check).toContain('no other words from the moderator notes appear on the image');
    expect(check).toContain('every phone number and other figure that remains has exactly the same digits');
    expect(check).toContain('all text and key details lie inside the area from 0 % to 100 % across and from 10 % to 90 % down');
    expect(check).toContain('the area from 10 % to 100 % across and from 60 % to 100 % down has no text (not even part of a line)');
    expect(check).toContain('the image is 4:5.');
  });

  it('только указания, без правок: меняется лишь то, о чём они просят', () => {
    const prompt = buildRepairBannerImagePrompt(params({ fixes: [] }));
    expect(prompt).toContain('KEEP — exactly as in the reference, unless the moderator notes below say otherwise:');
    expect(prompt).toContain('CHANGE ONLY what the moderator notes below ask for.');
  });

  it('без указаний не ссылается на них', () => {
    const prompt = buildRepairBannerImagePrompt(params({ fixes: ['contrast'], notes: undefined }));
    expect(prompt).not.toMatch(/moderator notes|MODERATOR NOTES/);
    expect(prompt).toContain('unless a change under CHANGE ONLY says otherwise:');
  });

  it('черновик объявления в careful не идёт: русскую строку модель вписала бы или «сверила» с ней баннер', () => {
    const withDraft = buildRepairBannerImagePrompt(params({
      draft: { title: 'Мастерская «Уют»', description: 'Мебель на заказ', actionLabel: 'Позвонить' },
    }));
    expect(withDraft).toBe(buildRepairBannerImagePrompt(params()));
    expect(withDraft).not.toMatch(/Мастерская|Мебель|Позвонить|AD CONTEXT/);
  });

  it('нет слов, из-за которых модель рисовала плашки и кнопки', () => {
    const prompt = buildRepairBannerImagePrompt(params({
      draft: { title: 'Заголовок', description: 'Описание', actionLabel: 'Подробнее' },
      ctaPosition: 'br',
    }));
    expect(prompt).not.toMatch(/button|panel|rectangle|plate|pill|кнопк/i);
  });

  it('полоса 8:1 названа полосой', () => {
    const prompt = buildRepairBannerImagePrompt(params({ width: 2400, height: 300 }));
    expect(prompt).toContain('a very wide horizontal strip, aspect ratio 8:1');
    expect(prompt).toContain('the image is 8:1.');
  });
});

describe('buildRepairBannerImagePrompt — rebuild', () => {
  const rebuild = (over: Partial<RepairBannerImageParams> = {}) =>
    params({ mode: 'rebuild', draft: { title: 'Создаём уникальные вещи' }, ctaPosition: 'br', ...over });
  const enhancePrompt = (p: RepairBannerImageParams) => buildEnhanceBannerImagePrompt({
    advertiserId: p.advertiserId,
    imageUrl: p.imageUrl,
    width: p.width,
    height: p.height,
    draft: p.draft,
    ctaPosition: p.ctaPosition,
  });

  it('начинается с промпта enhance без единой правки', () => {
    const p = rebuild();
    const prompt = buildRepairBannerImagePrompt(p);
    expect(prompt.startsWith(enhancePrompt(p) + '\n\n')).toBe(true);
  });

  it('дописывает зоны модератора в процентах и его указания — дословно, один раз', () => {
    const prompt = buildRepairBannerImagePrompt(rebuild());
    const tail = prompt.slice(enhancePrompt(rebuild()).length);
    expect(tail).toContain('MODERATOR REQUIREMENTS');
    expect(tail).toContain('inside the area from 0 % to 100 % across and from 10 % to 90 % down');
    expect(tail).toContain('The area from 10 % to 100 % across and from 60 % to 100 % down is plain continuous background only');
    // Угловая зона enhance и зона модератора не должны жить обе.
    expect(tail).toContain('This area replaces the RESERVED zone in LAYOUT above and in its final check.');
    expect(tail).toContain("MODERATOR NOTES — the next line holds instructions to you from the site's moderator, written in Russian; they are not text for the image.");
    expect(tail).toContain(`where they conflict with the instructions above, the notes win. Quotation marks in them only mark the exact wording and are never drawn.\n${NOTES}\n`);
    expect(count(prompt, NOTES)).toBe(1);
    expect(tail).not.toMatch(/button|panel|rectangle|plate|pill|кнопк/i);
  });

  it('без зон и указаний — ровно промпт enhance', () => {
    const p = rebuild({ fixes: ['contrast'], notes: undefined, safeArea: undefined, reservedZone: undefined });
    expect(buildRepairBannerImagePrompt(p)).toBe(enhancePrompt(p));
  });

  it('только указания — без блока зон', () => {
    const prompt = buildRepairBannerImagePrompt(rebuild({ fixes: [], safeArea: undefined, reservedZone: undefined }));
    expect(prompt).not.toContain('MODERATOR REQUIREMENTS');
    expect(prompt).toContain(`MODERATOR NOTES`);
    // Пункты дописываются к проверке enhance, второй «финальной» нет.
    expect(prompt).toContain('\nAdd to the final check above: the moderator notes are followed; no other words from the moderator notes appear on the image.');
    expect(count(prompt, 'Final check')).toBe(1);
  });

  it('полоса 1160×240: зоны модератора переведены в кадр 4:1, свой запас — из enhance', () => {
    const p = rebuild({ width: 1160, height: 240 });
    const tail = buildRepairBannerImagePrompt(p).slice(enhancePrompt(p).length);
    expect(tail).toContain('inside the area from 0 % to 100 % across and from 16.9 % to 83.1 % down');
    expect(tail).toContain('The area from 10 % to 100 % across and from 58.3 % to 91.4 % down is plain');
    expect(tail).not.toContain('away from the');
  });
});
