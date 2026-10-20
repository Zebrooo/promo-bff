import { describe, it, expect, vi } from 'vitest';
import sharp from 'sharp';
import { createAiCache } from '../../services/ai-cache';
import type { OpenrouterImageCallParams } from '../../services/openrouter-image-client';
import { handleRepairBannerImage, type RepairBannerImageDeps } from './handle';
import type { RepairBannerImageParams } from './types';

// 1×1 PNG — sharp его читает, транскод в webp под слот проходит честно
// (та же заглушка, что в banner-image-pipeline.test.ts).
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function deps(calls: OpenrouterImageCallParams[], image = PNG_1x1) {
  const transcribe = vi.fn(async () => 'Создаём уникальные вещи');
  const hit = vi.fn(() => ({ ok: true, count: 1 }));
  const append = vi.fn().mockResolvedValue(undefined);
  const d: RepairBannerImageDeps = {
    openrouterImage: {
      async call(params) {
        calls.push(params);
        return { imageDataUrl: image, model: 'google/test-image', costRub: 1 };
      },
    },
    imageCache: createAiCache(),
    rateLimit: { hit, clear: () => undefined, size: () => 0 },
    costLog: { append },
    headlineChecker: { transcribe },
  };
  return { d, transcribe, hit, append };
}

function params(over: Partial<RepairBannerImageParams> = {}): RepairBannerImageParams {
  return {
    advertiserId: 'mod:42',
    imageUrl: 'https://example.com/banner.png',
    width: 4,
    height: 5,
    mode: 'careful',
    fixes: ['fit_safe_area', 'contrast'],
    notes: 'Номер WhatsApp не меняй.',
    safeArea: { x: 0, y: 0.1, w: 1, h: 0.8 },
    draft: {},
    ...over,
  };
}

describe('handleRepairBannerImage', () => {
  it('careful: модель правит референс, сверки текста нет (его знает только человек)', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const { d, transcribe, hit, append } = deps(calls);
    const result = await handleRepairBannerImage(params(), d);

    expect(result).toMatchObject({ status: 'ok', data: { cacheHit: false, model: 'google/test-image' } });
    if (result.status === 'ok') expect(result.data.imageDataUrl.startsWith('data:image/webp;base64,')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].imageUrl).toBe('https://example.com/banner.png');
    expect(calls[0].aspectRatio).toBe('4:5');
    expect(calls[0].prompt).toContain('Edit the attached display-ad banner');
    expect(calls[0].prompt).toContain('Номер WhatsApp не меняй.');
    expect(transcribe).not.toHaveBeenCalled();
    // Свой бюджет у модератора: лимит и расходы — по «mod:<id>».
    expect(hit).toHaveBeenCalledWith('mod:42');
    expect(append).toHaveBeenCalledWith(expect.objectContaining({ advertiserId: 'mod:42' }));
  });

  it('rebuild: промпт enhance + указания, заголовок сверяется с готовой картинкой', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const { d, transcribe } = deps(calls);
    const result = await handleRepairBannerImage(
      params({ mode: 'rebuild', draft: { title: 'Создаём уникальные вещи' } }),
      d,
    );
    expect(result.status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('Design a finished display-ad banner');
    expect(calls[0].prompt).toContain('MODERATOR NOTES');
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it('rebuild: заголовок не прочитался — одна повторная генерация, как у enhance', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const { d, transcribe } = deps(calls);
    transcribe.mockResolvedValue('Сожий уникальные');
    await handleRepairBannerImage(params({ mode: 'rebuild', draft: { title: 'Создаём уникальные вещи' } }), d);
    expect(calls).toHaveLength(2);
  });

  it('тот же запрос с правками в другом порядке — из кэша', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const { d } = deps(calls);
    await handleRepairBannerImage(params(), d);
    const second = await handleRepairBannerImage(params({ fixes: ['contrast', 'fit_safe_area'] }), d);
    expect(calls).toHaveLength(1);
    expect(second).toMatchObject({ status: 'ok', data: { cacheHit: true } });
  });

  it('всё, что меняет картинку, меняет и ключ кэша', async () => {
    // Каждый вариант меняет ровно одно поле: иначе пропажу поля из ключа
    // маскировало бы соседнее (mode вместе с draft промахивался из-за draft).
    // draft и ctaPosition картинку меняют только в rebuild — там и проверяем.
    const careful = params();
    const rebuild = params({ mode: 'rebuild', draft: { title: 'Заголовок' } });
    const cases: [RepairBannerImageParams, Partial<RepairBannerImageParams>][] = [
      [careful, { mode: 'rebuild' }],
      [careful, { fixes: ['fit_safe_area'] }],
      [careful, { notes: 'Другое указание' }],
      [careful, { notes: undefined }],
      [careful, { safeArea: { x: 0, y: 0.2, w: 1, h: 0.8 } }],
      [careful, { reservedZone: { x: 0, y: 0.8, w: 1, h: 0.2 } }],
      [careful, { width: 8 }],
      [careful, { height: 10 }],
      [careful, { imageUrl: 'https://example.com/other.png' }],
      [careful, { advertiserId: 'mod:43' }],
      [careful, { variant: 1 }],
      [rebuild, { draft: { title: 'Другой заголовок' } }],
      [rebuild, { ctaPosition: 'tl' }],
    ];
    const { d } = deps([]);
    for (const base of [careful, rebuild]) await handleRepairBannerImage(base, d);
    for (const [base, over] of cases) {
      const result = await handleRepairBannerImage({ ...base, ...over }, d);
      expect(result, JSON.stringify(over)).toMatchObject({ status: 'ok', data: { cacheHit: false } });
    }
    // Контроль: исходные запросы по-прежнему из кэша.
    for (const base of [careful, rebuild]) {
      expect(await handleRepairBannerImage(base, d)).toMatchObject({ data: { cacheHit: true } });
    }
  });

  it('кадр модели кропится по центру в обоих режимах: под это пересчитаны зоны в промпте', async () => {
    // Кадр 40×10: левый квадрат ярко-красный, остальное серое. Кроп по
    // содержимому (attention) ушёл бы к красному, по центру — серая середина.
    const red = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const frame = await sharp({ create: { width: 40, height: 10, channels: 3, background: '#808080' } })
      .composite([{ input: red, left: 0, top: 0 }])
      .png()
      .toBuffer();
    const { d } = deps([], `data:image/png;base64,${frame.toString('base64')}`);
    for (const mode of ['careful', 'rebuild'] as const) {
      const result = await handleRepairBannerImage(
        params({ mode, width: 10, height: 10, draft: { title: 'Создаём уникальные вещи' } }),
        d,
      );
      if (result.status !== 'ok') throw new Error(`${mode}: ${result.reason}`);
      const { data, info } = await sharp(Buffer.from(result.data.imageDataUrl.split(',')[1]!, 'base64'))
        .raw()
        .toBuffer({ resolveWithObject: true });
      let redness = 0;
      for (let i = 0; i < data.length; i += info.channels) redness += data[i]! - data[i + 1]!;
      expect(redness / (data.length / info.channels), mode).toBeLessThan(20);
    }
  });

  it('лимит исчерпан → rate_limited без вызова модели', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const { d } = deps(calls);
    d.rateLimit = { hit: () => ({ ok: false, retryAfterMs: 1000, count: 99 }), clear: () => undefined, size: () => 0 };
    expect(await handleRepairBannerImage(params(), d)).toEqual({ status: 'error', reason: 'rate_limited' });
    expect(calls).toHaveLength(0);
  });
});
