import { describe, it, expect, vi } from 'vitest';
import { runBannerImage, type BannerImagePipelineDeps } from './banner-image-pipeline';
import { createAiCache } from './ai-cache';
import type { OpenrouterImageCallParams } from './openrouter-image-client';

// 1×1 PNG — sharp его читает, транскод в 8×1 webp проходит честно.
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

function deps(calls: OpenrouterImageCallParams[]): BannerImagePipelineDeps {
  return {
    openrouterImage: {
      async call(params) {
        calls.push(params);
        return { imageDataUrl: PNG_1x1, model: 'google/test-image', costRub: 1 };
      },
    },
    imageCache: createAiCache(),
    rateLimit: { hit: () => ({ ok: true, count: 1 }), clear: () => undefined, size: () => 0 },
    costLog: { append: vi.fn().mockResolvedValue(undefined) },
  };
}

describe('runBannerImage', () => {
  it('просит у модели соотношение сторон под целевой слот и отдаёт webp ровно W×H', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const result = await runBannerImage(
      { advertiserId: 'a', cacheKey: 'k', prompt: 'p', imageUrl: 'https://example.com/ref.png', width: 8, height: 1, label: 't' },
      deps(calls),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ prompt: 'p', imageUrl: 'https://example.com/ref.png', aspectRatio: '8:1' });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.data.imageDataUrl.startsWith('data:image/webp;base64,')).toBe(true);
  });

  it('text-to-image: референс не передаётся, соотношение всё равно задано', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    await runBannerImage({ advertiserId: 'a', cacheKey: 'k', prompt: 'p', width: 4, height: 5, label: 't' }, deps(calls));
    expect(calls[0].imageUrl).toBeUndefined();
    expect(calls[0].aspectRatio).toBe('4:5');
  });

  it('повтор по тому же ключу — из кэша, модель не зовётся', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const d = deps(calls);
    const req = { advertiserId: 'a', cacheKey: 'same', prompt: 'p', width: 8, height: 1, label: 't' };
    await runBannerImage(req, d);
    const second = await runBannerImage(req, d);
    expect(calls).toHaveLength(1);
    expect(second.status).toBe('ok');
    if (second.status === 'ok') expect(second.data.cacheHit).toBe(true);
  });

  it('лимит исчерпан → rate_limited без вызова модели', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const d = deps(calls);
    d.rateLimit = { hit: () => ({ ok: false, retryAfterMs: 1000, count: 99 }), clear: () => undefined, size: () => 0 };
    const result = await runBannerImage({ advertiserId: 'a', cacheKey: 'k', prompt: 'p', width: 8, height: 1, label: 't' }, d);
    expect(result).toEqual({ status: 'error', reason: 'rate_limited' });
    expect(calls).toHaveLength(0);
  });
});

describe('runBannerImage — референс', () => {
  it('референс вкладывается через inlineReference, модель получает data URL', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const d = deps(calls);
    d.inlineReference = async (url) => `data:image/webp;base64,${Buffer.from(url).toString('base64')}`;
    await runBannerImage({ advertiserId: 'a', cacheKey: 'k', prompt: 'p', imageUrl: 'https://storage.example/x.webp', width: 8, height: 1, label: 't' }, d);
    expect(calls[0].imageUrl).toBe(`data:image/webp;base64,${Buffer.from('https://storage.example/x.webp').toString('base64')}`);
  });

  it('референс не скачался → image_unavailable, модель не зовётся', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const d = deps(calls);
    d.inlineReference = async () => { throw new Error('reference-image: 404'); };
    const result = await runBannerImage({ advertiserId: 'a', cacheKey: 'k', prompt: 'p', imageUrl: 'https://storage.example/x.webp', width: 8, height: 1, label: 't' }, d);
    expect(result).toEqual({ status: 'error', reason: 'image_unavailable' });
    expect(calls).toHaveLength(0);
  });
});

describe('runBannerImage — сверка заголовка', () => {
  function checker(readings: string[]) {
    const seen: string[] = [];
    return {
      seen,
      checker: { async transcribe(url: string) { seen.push(url); return readings.shift() ?? ''; } },
    };
  }
  const req = { advertiserId: 'a', cacheKey: 'k', prompt: 'p', width: 8, height: 1, label: 't', expectedText: 'Твой Дом' };

  it('текст на месте — одна генерация', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const d = deps(calls);
    const c = checker(['«Твой Дом»']);
    d.headlineChecker = c.checker;
    const result = await runBannerImage(req, d);
    expect(result.status).toBe('ok');
    expect(calls).toHaveLength(1);
    expect(c.seen).toHaveLength(1);
    expect(c.seen[0].startsWith('data:image/webp;base64,')).toBe(true);
  });

  it('опечатка в первой картинке → вторая генерация, кэшируется вторая', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const d = deps(calls);
    const c = checker(['ПВЗ Дом', 'Твой Дом']);
    d.headlineChecker = c.checker;
    const result = await runBannerImage(req, d);
    expect(result.status).toBe('ok');
    expect(calls).toHaveLength(2);
    expect(c.seen).toHaveLength(2);
    expect(d.imageCache.get('k')).toBeDefined();
  });

  it('опечатка и во второй — картинка всё равно отдаётся, третьей попытки нет', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const d = deps(calls);
    d.headlineChecker = checker(['ПВЗ Дом', 'ПВЗ Дом']).checker;
    const result = await runBannerImage(req, d);
    expect(result.status).toBe('ok');
    expect(calls).toHaveLength(2);
  });

  it('сбой проверки — картинка принимается без повтора', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const d = deps(calls);
    d.headlineChecker = { async transcribe() { throw new Error('headline-check: 503'); } };
    const result = await runBannerImage(req, d);
    expect(result.status).toBe('ok');
    expect(calls).toHaveLength(1);
  });

  it('без expectedText (text-to-image) проверка не зовётся', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const d = deps(calls);
    const c = checker(['что угодно']);
    d.headlineChecker = c.checker;
    await runBannerImage({ ...req, expectedText: undefined }, d);
    expect(c.seen).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it('каждая генерация попадает в cost-log, лимит списывается один раз', async () => {
    const calls: OpenrouterImageCallParams[] = [];
    const d = deps(calls);
    const hits = vi.fn(() => ({ ok: true, count: 1 }));
    d.rateLimit = { hit: hits, clear: () => undefined, size: () => 0 };
    d.headlineChecker = checker(['ПВЗ Дом', 'Твой Дом']).checker;
    await runBannerImage(req, d);
    expect(hits).toHaveBeenCalledTimes(1);
    expect(d.costLog.append).toHaveBeenCalledTimes(2);
  });
});
