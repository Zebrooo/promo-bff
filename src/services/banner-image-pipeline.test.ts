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
