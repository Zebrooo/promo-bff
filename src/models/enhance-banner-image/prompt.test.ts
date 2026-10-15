import { describe, it, expect } from 'vitest';
import { buildEnhanceBannerImagePrompt, cleanBannerText } from './prompt';
import type { EnhanceBannerImageParams } from './types';

function params(over: Partial<EnhanceBannerImageParams> = {}): EnhanceBannerImageParams {
  return {
    advertiserId: 'adv-1',
    imageUrl: 'https://example.com/photo.jpg',
    width: 2400,
    height: 300,
    draft: { title: 'Строим дома под ключ' },
    ...over,
  };
}

describe('buildEnhanceBannerImagePrompt', () => {
  it('заголовок попадает в промпт дословно, без кавычек, и повторяется в финальной проверке', () => {
    const prompt = buildEnhanceBannerImagePrompt(params());
    // Текст — отдельной строкой без кавычек: «ёлочки» модель рисовала на баннере.
    expect(prompt).toContain('without adding quotation marks around it:\nСтроим дома под ключ\n');
    expect(prompt).toContain('the headline reads exactly: Строим дома под ключ — every letter correct');
    expect(prompt).not.toContain('«Строим дома под ключ»');
  });

  it('полоса 8:1: форма названа, кнопка справа → правая четверть зарезервирована, предмет слева', () => {
    const prompt = buildEnhanceBannerImagePrompt(params({ ctaPosition: 'br' }));
    expect(prompt).toContain('aspect ratio 8:1');
    expect(prompt).toContain('a very wide horizontal strip');
    expect(prompt).toContain('Left third: the subject');
    expect(prompt).toContain('Right 25 % of the width: RESERVED');
    expect(prompt).toContain('the image is 8:1');
  });

  it('полоса, кнопка слева → зеркально', () => {
    const prompt = buildEnhanceBannerImagePrompt(params({ ctaPosition: 'bl' }));
    expect(prompt).toContain('Right third: the subject');
    expect(prompt).toContain('Left 25 % of the width: RESERVED');
  });

  it('без ctaPosition — как для правого нижнего угла (умолчание кабинета)', () => {
    const a = buildEnhanceBannerImagePrompt(params({ ctaPosition: undefined }));
    const b = buildEnhanceBannerImagePrompt(params({ ctaPosition: 'br' }));
    expect(a).toBe(b);
  });

  it('блок 600×750 — постер 4:5: заголовок сверху, нижние 30 % зарезервированы', () => {
    const prompt = buildEnhanceBannerImagePrompt(params({ width: 600, height: 750, ctaPosition: 'br' }));
    expect(prompt).toContain('aspect ratio 4:5');
    expect(prompt).toContain('a vertical poster');
    expect(prompt).toContain('Top part (about 25 % of the height): the headline');
    expect(prompt).toContain('Bottom 30 % of the height: RESERVED');
  });

  it('постер с кнопкой сверху — заголовок снизу, верхние 30 % зарезервированы', () => {
    const prompt = buildEnhanceBannerImagePrompt(params({ width: 600, height: 1000, ctaPosition: 'tr' }));
    expect(prompt).toContain('aspect ratio 9:16');
    expect(prompt).toContain('Bottom part (about 25 % of the height): the headline');
    expect(prompt).toContain('Top 30 % of the height: RESERVED');
  });

  it('ландшафт 16:9 — предмет на дальней половине, зарезервирована четверть у кнопки', () => {
    const prompt = buildEnhanceBannerImagePrompt(params({ width: 1600, height: 900, ctaPosition: 'tl' }));
    expect(prompt).toContain('aspect ratio 16:9');
    expect(prompt).toContain('Right half: the subject');
    expect(prompt).toContain('Left half, bottom part: the headline');
    expect(prompt).toContain('Left-top quarter');
  });

  it('число строк — от длины заголовка и формы', () => {
    expect(buildEnhanceBannerImagePrompt(params({ draft: { title: 'Шины -30%' } }))).toContain('on a single line');
    expect(buildEnhanceBannerImagePrompt(params({ draft: { title: 'Зоомагазин «Кошкин Дом» — всё для питомцев' } })))
      .toContain('broken into two balanced lines');
    expect(buildEnhanceBannerImagePrompt(params({ draft: { title: 'Зоомагазин «Кошкин Дом» — всё для ваших питомцев и даже больше' } })))
      .toContain('two or three short balanced lines');
    // Постер: порог одной строки ниже, чем у полосы.
    expect(buildEnhanceBannerImagePrompt(params({ width: 600, height: 750, draft: { title: 'Кофемашины на любой вкус' } })))
      .toContain('broken into two balanced lines');
  });

  it('подзаголовок добавляется второй строкой, без него строки «Below it» нет', () => {
    const withSub = buildEnhanceBannerImagePrompt(params({ draft: { title: 'Заголовок', description: 'Подзаголовок' } }));
    expect(withSub).toContain('Below it, smaller and lighter, exactly the text on the next line:\nПодзаголовок\n');
    expect(buildEnhanceBannerImagePrompt(params())).not.toContain('Below it');
  });

  it('только описание без заголовка — оно и становится главным текстом', () => {
    const prompt = buildEnhanceBannerImagePrompt(params({ draft: { description: 'Только описание' } }));
    expect(prompt).toContain('around it:\nТолько описание\n');
    expect(prompt).not.toContain('Below it');
  });

  it('прямые кавычки в заголовке становятся «ёлочками», пробелы схлопываются', () => {
    const prompt = buildEnhanceBannerImagePrompt(params({ draft: { title: '  Зоомагазин  "Кошкин Дом"\n— всё для питомцев ' } }));
    expect(prompt).toContain('around it:\nЗоомагазин «Кошкин Дом» — всё для питомцев\n');
  });

  it('actionLabel на картинку не попадает — кнопку рисует витрина', () => {
    const prompt = buildEnhanceBannerImagePrompt(params({ draft: { title: 'Заголовок', actionLabel: 'Купить сейчас' } }));
    expect(prompt).not.toContain('Купить сейчас');
  });

  it('старые ловушки ушли: нет «угол только фон» и описания панелей/стёкол, нет резерва левого верхнего угла под метку', () => {
    const prompt = buildEnhanceBannerImagePrompt(params({ ctaPosition: 'br' }));
    expect(prompt).not.toMatch(/frosted|glass|rectangle|bokeh/i);
    expect(prompt).not.toContain('top-left corner');
    // «Здесь сайт поставит кнопку» модель воплощала белой плашкой в зоне.
    expect(prompt).not.toMatch(/button|pill|panel/i);
  });
});

describe('cleanBannerText', () => {
  it('пусто → пусто', () => {
    expect(cleanBannerText(undefined)).toBe('');
    expect(cleanBannerText('   ')).toBe('');
  });

  it('непарная кавычка просто убирается', () => {
    expect(cleanBannerText('Дом "у моря')).toBe('Дом у моря');
  });
});

describe('buildEnhanceBannerImagePrompt — кегль полосы', () => {
  it('у полосы 8:1 кегль 35–45 %, у телефонной 4,83:1 — 22–30 %', () => {
    expect(buildEnhanceBannerImagePrompt(params({ width: 2400, height: 300 }))).toContain('cap height about 35–45 %');
    expect(buildEnhanceBannerImagePrompt(params({ width: 1160, height: 240 }))).toContain('cap height about 22–30 %');
    expect(buildEnhanceBannerImagePrompt(params({ width: 1160, height: 240 }))).toContain('Left quarter: the subject');
  });
});
