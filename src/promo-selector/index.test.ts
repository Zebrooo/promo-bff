import { describe, expect, it, vi } from 'vitest';
import { selectPromo, selectPromoList, WEB_CHECKERS, type SelectionTrace } from './index';
import { __clearUserDataCache, type SupplierDeps } from './checkers/suppliers';
import { makePromo, makeListingStats } from '../test-utils';

function makeDeps(over: Partial<{ counts: Record<string, number>; lastShownAt: Record<string, string> }> = {}): SupplierDeps {
  return {
    userService: { getUserProfile: async (id: string) => ({ userId: id, age: 30, region: 'ru' }) },
    billingService: { getSubscription: async () => ({ level: 'plus' as const }) },
    impressionStore: {
      getImpressions: async () => ({ counts: over.counts ?? {}, lastShownAt: over.lastShownAt ?? {} }),
      recordImpression: async () => {},
    },
    listingService: { getListingStats: async () => makeListingStats(0).listingStats },
  };
}

const ctx = {
  userId: 'u1',
  isAuthorized: false,
  identityKind: 'anonymous' as const,
  now: new Date('2024-06-01T12:00:00.000Z'),
};

describe('selectPromo', () => {
  it('returns the first promo passing every checker, in queue order', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'a' }), makePromo({ id: 'b' })];
    const result = await selectPromo(promos, ctx, { deps: makeDeps() });
    expect(result?.id).toBe('a');
  });

  it('returns null when the queue is empty', async () => {
    expect(await selectPromo([], ctx, { deps: makeDeps() })).toBeNull();
  });

  it('rejects a promo blocked by the cooldown checker', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'p', cooldownHours: 24 })];
    const deps = makeDeps({ lastShownAt: { p: '2024-06-01T11:00:00.000Z' } });
    expect(await selectPromo(promos, ctx, { deps })).toBeNull();
  });

  it('skip removes a checker so a blocked promo passes', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'p', cooldownHours: 24 })];
    const deps = makeDeps({ lastShownAt: { p: '2024-06-01T11:00:00.000Z' } });
    const result = await selectPromo(promos, ctx, { deps, skip: ['cooldown'] });
    expect(result?.id).toBe('p');
  });

  it('skips a desktop-only promo at the queue head and falls through for a touch user', async () => {
    __clearUserDataCache();
    // Head promo is topline (desktop-only format); next is touch-capable inline.
    const promos = [makePromo({ id: 'top', format: 'topline' }), makePromo({ id: 'inl', format: 'inline' })];
    const result = await selectPromo(promos, { ...ctx, device: 'touch' }, { deps: makeDeps() });
    expect(result?.id).toBe('inl');
  });

  it('respects an explicit deviceTarget for a touch user', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'd', deviceTarget: 'desktop' }), makePromo({ id: 't', deviceTarget: 'touch' })];
    const result = await selectPromo(promos, { ...ctx, device: 'touch' }, { deps: makeDeps() });
    expect(result?.id).toBe('t');
  });

  it('does not filter by device when the request carries no device', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'top', format: 'topline', deviceTarget: 'desktop' })];
    const result = await selectPromo(promos, ctx, { deps: makeDeps() });
    expect(result?.id).toBe('top');
  });

  it('format filter picks the requested surface format from a mixed-format queue', async () => {
    __clearUserDataCache();
    // A per-catalog queue holding a topline banner then an overlay popup.
    const promos = [makePromo({ id: 'top', format: 'topline' }), makePromo({ id: 'pop', format: 'popup' })];
    // Overlay surface asks only for popup/fullscreen → skips the topline head.
    const overlay = await selectPromo(promos, { ...ctx, formats: ['popup', 'fullscreen'] }, { deps: makeDeps() });
    expect(overlay?.id).toBe('pop');
    // Topline surface asks only for topline → gets the banner.
    __clearUserDataCache();
    const topline = await selectPromo(promos, { ...ctx, formats: ['topline'] }, { deps: makeDeps() });
    expect(topline?.id).toBe('top');
  });

  it('no formats filter keeps queue order (back-compat)', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'top', format: 'topline' }), makePromo({ id: 'pop', format: 'popup' })];
    const result = await selectPromo(promos, ctx, { deps: makeDeps() });
    expect(result?.id).toBe('top');
  });

  it('does not load suppliers when only context-only checkers are active', async () => {
    __clearUserDataCache();
    const deps = makeDeps();
    const getImpressions = vi.spyOn(deps.impressionStore, 'getImpressions');
    // skip the userData checkers (targeting/visitor/limit/cooldown/chain) → context-only remain
    await selectPromo([makePromo({ id: 'a' })], ctx, {
      deps,
      skip: ['targeting', 'visitor', 'limit', 'cooldown', 'chain'],
    });
    expect(getImpressions).not.toHaveBeenCalled();
  });
});

describe('selectPromo trace (onTrace)', () => {
  it('reports pass/skip per checker and the winner; is called exactly once', async () => {
    __clearUserDataCache();
    const traces: SelectionTrace[] = [];
    const result = await selectPromo([makePromo({ id: 'a' })], ctx, {
      deps: makeDeps(),
      onTrace: (t) => traces.push(t),
    });
    expect(result?.id).toBe('a');
    expect(traces).toHaveLength(1);
    const [trace] = traces;
    expect(trace.selectedPromoId).toBe('a');
    expect(trace.candidates).toHaveLength(1);
    expect(trace.candidates[0].promoId).toBe('a');
    // Every active checker produced a verdict, in evaluation order, no hardcoded subset.
    expect(trace.candidates[0].checks.map((c) => c.checker)).toEqual(WEB_CHECKERS.map((c) => c.name));
    // Default promo has no cap → the limit checker self-skips with its shouldSkip reason.
    expect(trace.candidates[0].checks.find((c) => c.checker === 'limit')).toEqual({
      checker: 'limit', outcome: 'skip', reason: 'no cap configured',
    });
    expect(trace.candidates[0].checks.find((c) => c.checker === 'date')).toEqual({
      checker: 'date', outcome: 'pass', reason: '',
    });
    // A skip never carries an empty reason; a pass always does.
    for (const chk of trace.candidates[0].checks) {
      if (chk.outcome === 'skip') expect(chk.reason).not.toBe('');
      if (chk.outcome === 'pass') expect(chk.reason).toBe('');
    }
  });

  it('records a fail with the checker expect() reason and stops that candidate at the first fail', async () => {
    __clearUserDataCache();
    const traces: SelectionTrace[] = [];
    const expired = makePromo({ id: 'old', endsAt: '2000-01-01T00:00:00.000Z' });
    const result = await selectPromo([expired, makePromo({ id: 'ok' })], ctx, {
      deps: makeDeps(),
      onTrace: (t) => traces.push(t),
    });
    expect(result?.id).toBe('ok');
    const [trace] = traces;
    expect(trace.selectedPromoId).toBe('ok');
    expect(trace.candidates.map((c) => c.promoId)).toEqual(['old', 'ok']);
    // 'old' fails the date checker first → later checkers never ran for it.
    expect(trace.candidates[0].checks).toEqual([
      { checker: 'date', outcome: 'fail', reason: 'now is within [startsAt, endsAt] and MSK time matches schedule' },
    ]);
  });

  it('reports selectedPromoId null when every candidate fails', async () => {
    __clearUserDataCache();
    const traces: SelectionTrace[] = [];
    const expired = makePromo({ id: 'old', endsAt: '2000-01-01T00:00:00.000Z' });
    const result = await selectPromo([expired], ctx, { deps: makeDeps(), onTrace: (t) => traces.push(t) });
    expect(result).toBeNull();
    expect(traces).toHaveLength(1);
    expect(traces[0].selectedPromoId).toBeNull();
    expect(traces[0].candidates).toHaveLength(1);
  });

  it('excludeIds drops promos BEFORE the walk — they never appear in the trace', async () => {
    __clearUserDataCache();
    const traces: SelectionTrace[] = [];
    await selectPromo([makePromo({ id: 'a' }), makePromo({ id: 'b' })], { ...ctx, excludeIds: ['a'] }, {
      deps: makeDeps(),
      onTrace: (t) => traces.push(t),
    });
    expect(traces[0].candidates.map((c) => c.promoId)).toEqual(['b']);
    expect(traces[0].selectedPromoId).toBe('b');
  });

  it('a throwing onTrace does not break selection', async () => {
    __clearUserDataCache();
    const result = await selectPromo([makePromo({ id: 'a' })], ctx, {
      deps: makeDeps(),
      onTrace: () => {
        throw new Error('observer boom');
      },
    });
    expect(result?.id).toBe('a');
  });
});

describe('selectPromoList', () => {
  it('returns ALL passing promos in queue order (not just the first)', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'a' }), makePromo({ id: 'b' }), makePromo({ id: 'c' })];
    const result = await selectPromoList(promos, ctx, { deps: makeDeps() });
    expect(result.map((p) => p.id)).toEqual(['a', 'b', 'c']);
  });

  it('drops a checker-blocked promo but keeps the rest, in order', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'a' }), makePromo({ id: 'blocked', cooldownHours: 24 }), makePromo({ id: 'c' })];
    const deps = makeDeps({ lastShownAt: { blocked: '2024-06-01T11:00:00.000Z' } });
    const result = await selectPromoList(promos, ctx, { deps });
    expect(result.map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('returns [] when the queue is empty', async () => {
    expect(await selectPromoList([], ctx, { deps: makeDeps() })).toEqual([]);
  });

  it('skip removes a checker so a blocked promo is included', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'blocked', cooldownHours: 24 })];
    const deps = makeDeps({ lastShownAt: { blocked: '2024-06-01T11:00:00.000Z' } });
    const result = await selectPromoList(promos, ctx, { deps, skip: ['cooldown'] });
    expect(result.map((p) => p.id)).toEqual(['blocked']);
  });

  it('excludeIds drops promos BEFORE the walk', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'a' }), makePromo({ id: 'b' }), makePromo({ id: 'c' })];
    const result = await selectPromoList(promos, { ...ctx, excludeIds: ['b'] }, { deps: makeDeps() });
    expect(result.map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('emits ONE trace: selectedPromoIds = every included id; candidates = every evaluated id', async () => {
    __clearUserDataCache();
    const traces: SelectionTrace[] = [];
    const promos = [
      makePromo({ id: 'a' }),
      makePromo({ id: 'blocked', endsAt: '2000-01-01T00:00:00.000Z' }),
      makePromo({ id: 'c' }),
    ];
    const result = await selectPromoList(promos, ctx, { deps: makeDeps(), onTrace: (t) => traces.push(t) });
    expect(result.map((p) => p.id)).toEqual(['a', 'c']);
    expect(traces).toHaveLength(1);
    expect(traces[0].selectedPromoIds).toEqual(['a', 'c']);
    expect(traces[0].candidates.map((c) => c.promoId)).toEqual(['a', 'blocked', 'c']);
  });
});

describe('selectPromo env targeting', () => {
  it("checker order: 'env' стоит сразу после 'device' (Date → … → Device → Env → Format → …)", () => {
    expect(WEB_CHECKERS.map((c) => c.name)).toEqual([
      'date', 'targeting', 'geo', 'audience', 'visitor', 'source', 'context', 'search', 'purchases', 'balance',
      'interest', 'hot-buyer', 'engagement',
      'device', 'env', 'format', 'seller', 'lifecycle', 'listings', 'limit', 'cooldown', 'chain',
    ]);
  });

  it('fail-closed: env-таргетированное промо без сигнала падает, очередь идёт дальше', async () => {
    __clearUserDataCache();
    const promos = [
      makePromo({ id: 'tg-only', targeting: { environments: ['telegram'] } }),
      makePromo({ id: 'fallback' }),
    ];
    const result = await selectPromo(promos, ctx, { deps: makeDeps() });
    expect(result?.id).toBe('fallback');
  });

  it('совпавший сигнал проходит; несовпавший по любой оси — AND-fail', async () => {
    __clearUserDataCache();
    const promos = [makePromo({ id: 'p', targeting: { os: ['ios'], environments: ['telegram'] } })];
    const hit = await selectPromo(promos, { ...ctx, env: { os: 'ios', runtime: 'telegram' } }, { deps: makeDeps() });
    expect(hit?.id).toBe('p');
    __clearUserDataCache();
    const miss = await selectPromo(promos, { ...ctx, env: { os: 'ios', runtime: 'browser' } }, { deps: makeDeps() });
    expect(miss).toBeNull();
  });

  it('промо без env-правил не затронуто: в трейсе skip с причиной', async () => {
    __clearUserDataCache();
    const traces: SelectionTrace[] = [];
    await selectPromo([makePromo({ id: 'a' })], ctx, { deps: makeDeps(), onTrace: (t) => traces.push(t) });
    expect(traces[0].candidates[0].checks.find((c) => c.checker === 'env')).toEqual({
      checker: 'env', outcome: 'skip', reason: 'no env targeting rules',
    });
  });
});
