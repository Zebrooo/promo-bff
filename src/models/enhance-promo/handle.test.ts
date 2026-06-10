import { describe, it, expect, vi } from 'vitest';
import { handleEnhancePromo, type CachedSuggestion, type EnhanceDeps } from './handle';
import { createAiCache } from '../../services/ai-cache';
import { createRateLimitStore } from '../../services/rate-limit-store';
import type { OpenrouterClient } from '../../services/openrouter-client';
import type { CostLog } from '../../services/cost-log';

function makeOpenrouter(
  text: string,
  overrides?: Partial<{ model: string; tokensIn: number; tokensOut: number; costRub: number }>,
): OpenrouterClient & { call: ReturnType<typeof vi.fn> } {
  const call = vi.fn().mockResolvedValue({
    text,
    model: overrides?.model ?? 'openai/gpt-4o-mini',
    tokensIn: overrides?.tokensIn ?? 100,
    tokensOut: overrides?.tokensOut ?? 50,
    costRub: overrides?.costRub ?? 0.05,
  });
  return { call };
}

function makeFailingOpenrouter(err: Error): OpenrouterClient {
  return { call: vi.fn().mockRejectedValue(err) };
}

function makeCostLog(): { log: CostLog; appended: unknown[] } {
  const appended: unknown[] = [];
  const log: CostLog = { append: vi.fn(async (e) => { appended.push(e); }) };
  return { log, appended };
}

function makeDeps(overrides: Partial<EnhanceDeps> = {}): EnhanceDeps {
  return {
    openrouter: overrides.openrouter ?? makeOpenrouter('{"title":"улучшено"}'),
    cache: overrides.cache ?? createAiCache<CachedSuggestion>({ defaultTtlMs: 60_000 }),
    rateLimit: overrides.rateLimit ?? createRateLimitStore({ limit: 30, windowMs: 60 * 60 * 1000 }),
    costLog: overrides.costLog ?? makeCostLog().log,
    logger: overrides.logger,
  };
}

describe('handleEnhancePromo', () => {
  it('happy path: calls openrouter, returns suggestions, caches, logs cost', async () => {
    const openrouter = makeOpenrouter('{"title":"Лето −30%","description":"Скидки до 30% на каталог."}');
    const { log: costLog, appended } = makeCostLog();
    const deps = makeDeps({ openrouter, costLog });

    const result = await handleEnhancePromo(
      { advertiserId: 'adv1', draft: { title: 'летняя распродажа', description: 'низкие цены' } },
      deps,
    );

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.data.cacheHit).toBe(false);
    expect(result.data.suggestions).toEqual({
      title: 'Лето −30%',
      description: 'Скидки до 30% на каталог.',
    });
    expect(result.data.model).toBe('openai/gpt-4o-mini');
    expect(openrouter.call).toHaveBeenCalledOnce();
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      advertiserId: 'adv1',
      model: 'openai/gpt-4o-mini',
      tokensIn: 100,
      tokensOut: 50,
      costRub: 0.05,
    });
  });

  it('cache hit: identical draft → cached suggestions, cacheHit:true, no new openrouter call, no new cost-log entry', async () => {
    const openrouter = makeOpenrouter('{"title":"Лето −30%"}');
    const { log: costLog, appended } = makeCostLog();
    const deps = makeDeps({ openrouter, costLog });
    const params = { advertiserId: 'adv1', draft: { title: 'летняя распродажа' } };

    const first = await handleEnhancePromo(params, deps);
    const second = await handleEnhancePromo(params, deps);

    expect(first.status).toBe('ok');
    expect(second.status).toBe('ok');
    if (second.status !== 'ok') return;
    expect(second.data.cacheHit).toBe(true);
    expect(second.data.suggestions).toEqual({ title: 'Лето −30%' });
    expect(openrouter.call).toHaveBeenCalledOnce(); // not called twice
    expect(appended).toHaveLength(1);               // not appended twice
  });

  it('cache key is stable across draft property order', async () => {
    const openrouter = makeOpenrouter('{"title":"X"}');
    const deps = makeDeps({ openrouter });

    await handleEnhancePromo({ advertiserId: 'a', draft: { title: 't', description: 'd' } }, deps);
    const second = await handleEnhancePromo(
      { advertiserId: 'a', draft: { description: 'd', title: 't' } as Record<string, unknown> },
      deps,
    );

    expect(second.status).toBe('ok');
    if (second.status === 'ok') expect(second.data.cacheHit).toBe(true);
    expect(openrouter.call).toHaveBeenCalledOnce();
  });

  it('rate-limit: 31st call within window → error:rate_limited (no openrouter call)', async () => {
    const openrouter = makeOpenrouter('{"title":"X"}');
    const rateLimit = createRateLimitStore({ limit: 30, windowMs: 60 * 60 * 1000 });
    const deps = makeDeps({ openrouter, rateLimit });

    // 30 distinct drafts to avoid cache hits.
    for (let i = 0; i < 30; i++) {
      const r = await handleEnhancePromo({ advertiserId: 'adv1', draft: { title: `t${i}` } }, deps);
      expect(r.status).toBe('ok');
    }
    const blocked = await handleEnhancePromo({ advertiserId: 'adv1', draft: { title: 't31' } }, deps);
    expect(blocked.status).toBe('error');
    if (blocked.status === 'error') expect(blocked.reason).toBe('rate_limited');
    expect(openrouter.call).toHaveBeenCalledTimes(30); // not 31
  });

  it('rate-limit is per advertiser (other advertisers still go through)', async () => {
    const openrouter = makeOpenrouter('{"title":"X"}');
    const rateLimit = createRateLimitStore({ limit: 1, windowMs: 60 * 60 * 1000 });
    const deps = makeDeps({ openrouter, rateLimit });

    expect((await handleEnhancePromo({ advertiserId: 'adv1', draft: { title: 't' } }, deps)).status).toBe('ok');
    expect((await handleEnhancePromo({ advertiserId: 'adv2', draft: { title: 't' } }, deps)).status).toBe('ok');
  });

  it('openrouter throws → error:openrouter_unavailable, no cache write, rate-limit consumed', async () => {
    const openrouter = makeFailingOpenrouter(new Error('boom'));
    const { log: costLog, appended } = makeCostLog();
    const cache = createAiCache<CachedSuggestion>();
    const deps = makeDeps({ openrouter, costLog, cache });

    const r = await handleEnhancePromo({ advertiserId: 'adv1', draft: { title: 't' } }, deps);

    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.reason).toBe('openrouter_unavailable');
    expect(cache.size()).toBe(0);
    expect(appended).toHaveLength(0);
  });

  it('malformed JSON in reply → error:malformed_response', async () => {
    const openrouter = makeOpenrouter('извини, не понял запрос — попробуй ещё');
    const cache = createAiCache<CachedSuggestion>();
    const deps = makeDeps({ openrouter, cache });

    const r = await handleEnhancePromo({ advertiserId: 'adv1', draft: { title: 't' } }, deps);

    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.reason).toBe('malformed_response');
    expect(cache.size()).toBe(0);
  });

  it('strips ```json fences``` and parses the inner object', async () => {
    const openrouter = makeOpenrouter('```json\n{"title":"Сжато"}\n```');
    const deps = makeDeps({ openrouter });

    const r = await handleEnhancePromo({ advertiserId: 'adv1', draft: { title: 't' } }, deps);

    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.data.suggestions).toEqual({ title: 'Сжато' });
  });

  it('drops fields the model returned with empty/whitespace values', async () => {
    const openrouter = makeOpenrouter('{"title":"   ","description":"оk","action":{"label":""}}');
    const deps = makeDeps({ openrouter });

    const r = await handleEnhancePromo({ advertiserId: 'adv1', draft: { title: 't' } }, deps);

    expect(r.status).toBe('ok');
    if (r.status === 'ok') expect(r.data.suggestions).toEqual({ description: 'оk' });
  });

  it('valid JSON but with no usable text fields → malformed_response', async () => {
    const openrouter = makeOpenrouter('{"random":"thing","numbers":[1,2,3]}');
    const deps = makeDeps({ openrouter });

    const r = await handleEnhancePromo({ advertiserId: 'adv1', draft: { title: 't' } }, deps);

    expect(r.status).toBe('error');
    if (r.status === 'error') expect(r.reason).toBe('malformed_response');
  });

  it('cost-log failure does NOT fail the response', async () => {
    const openrouter = makeOpenrouter('{"title":"X"}');
    const costLog: CostLog = { append: vi.fn().mockRejectedValue(new Error('disk full')) };
    const errors: unknown[] = [];
    const logger = { info: () => {}, error: (obj: unknown) => { errors.push(obj); } };
    const deps = makeDeps({ openrouter, costLog, logger });

    const r = await handleEnhancePromo({ advertiserId: 'adv1', draft: { title: 't' } }, deps);

    expect(r.status).toBe('ok');
    expect(errors).toHaveLength(1); // we logged the cost-log failure
  });

  it('passes pages and cpm suggestions through when LLM returned them and availablePages whitelisted them', async () => {
    const openrouter = makeOpenrouter(JSON.stringify({
      title: 'X',
      pages: { keys: ['auto', 'services'], reason: 'товар попадает в авто-категории' },
      cpm: { value: 7, reason: 'конкуренция выше базовой' },
    }));
    const deps = makeDeps({ openrouter });

    const r = await handleEnhancePromo(
      {
        advertiserId: 'adv1',
        draft: { title: 't' },
        availablePages: [
          { key: 'home', name: 'Главная' },
          { key: 'auto', name: 'Авто' },
          { key: 'services', name: 'Услуги' },
        ],
      },
      deps,
    );

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.suggestions.pages).toEqual({ keys: ['auto', 'services'], reason: 'товар попадает в авто-категории' });
    expect(r.data.suggestions.cpm).toEqual({ value: 7, reason: 'конкуренция выше базовой' });
  });

  it('omits pages-suggestion when availablePages was NOT passed (back-compat for promo-cabinet)', async () => {
    const openrouter = makeOpenrouter(JSON.stringify({
      title: 'X',
      pages: { keys: ['auto'], reason: 'whatever' },
    }));
    const deps = makeDeps({ openrouter });

    const r = await handleEnhancePromo({ advertiserId: 'adv1', draft: { title: 't' } }, deps);

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.suggestions.pages).toBeUndefined();
  });

  it('omits cpm-suggestion when availablePages was NOT passed (back-compat for promo-cabinet)', async () => {
    const openrouter = makeOpenrouter(JSON.stringify({
      title: 'X',
      cpm: { value: 7, reason: 'whatever' },
    }));
    const deps = makeDeps({ openrouter });

    const r = await handleEnhancePromo({ advertiserId: 'adv1', draft: { title: 't' } }, deps);

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.suggestions.cpm).toBeUndefined();
  });

  it('filters pages keys against availablePages whitelist (drops unknown keys)', async () => {
    const openrouter = makeOpenrouter(JSON.stringify({
      title: 'X',
      pages: { keys: ['auto', 'nonexistent'], reason: 'mixed' },
    }));
    const deps = makeDeps({ openrouter });

    const r = await handleEnhancePromo(
      {
        advertiserId: 'adv1',
        draft: { title: 't' },
        availablePages: [{ key: 'auto', name: 'Авто' }],
      },
      deps,
    );

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.suggestions.pages?.keys).toEqual(['auto']);
  });

  it('omits pages-suggestion when ALL keys filter out', async () => {
    const openrouter = makeOpenrouter(JSON.stringify({
      title: 'X',
      pages: { keys: ['nope', 'nada'], reason: 'mixed' },
    }));
    const deps = makeDeps({ openrouter });

    const r = await handleEnhancePromo(
      { advertiserId: 'adv1', draft: { title: 't' }, availablePages: [{ key: 'auto', name: 'Авто' }] },
      deps,
    );

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.suggestions.pages).toBeUndefined();
  });

  it('drops cpm suggestion when value is out of [1, 50] range', async () => {
    const openrouter = makeOpenrouter(JSON.stringify({
      title: 'X',
      cpm: { value: 999, reason: 'go high' },
    }));
    const deps = makeDeps({ openrouter });

    const r = await handleEnhancePromo(
      { advertiserId: 'adv1', draft: { title: 't' }, availablePages: [{ key: 'home', name: 'Главная' }] },
      deps,
    );

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.suggestions.cpm).toBeUndefined();
  });

  it('drops cpm suggestion when value is missing or not a number', async () => {
    const openrouter = makeOpenrouter(JSON.stringify({
      title: 'X',
      cpm: { value: 'seven', reason: 'string' },
    }));
    const deps = makeDeps({ openrouter });

    const r = await handleEnhancePromo(
      { advertiserId: 'adv1', draft: { title: 't' }, availablePages: [{ key: 'home', name: 'Главная' }] },
      deps,
    );

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.suggestions.cpm).toBeUndefined();
  });

  it('drops pages suggestion when reason is missing (need both keys+reason)', async () => {
    const openrouter = makeOpenrouter(JSON.stringify({
      title: 'X',
      pages: { keys: ['auto'] },  // no reason
    }));
    const deps = makeDeps({ openrouter });

    const r = await handleEnhancePromo(
      { advertiserId: 'adv1', draft: { title: 't' }, availablePages: [{ key: 'auto', name: 'Авто' }] },
      deps,
    );

    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.data.suggestions.pages).toBeUndefined();
  });
});
