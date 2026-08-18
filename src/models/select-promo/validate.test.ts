import { describe, expect, it } from 'vitest';
import { validateParams } from './validate';

describe('validateParams', () => {
  it('accepts params with a userId and returns the typed params', () => {
    const result = validateParams({ userId: 'user123', context: { platform: 'web', locale: 'ru' } });
    expect(result).toEqual({
      ok: true,
      params: { userId: 'user123', context: { platform: 'web', locale: 'ru' } },
    });
  });

  it('accepts params with userId and no context', () => {
    const result = validateParams({ userId: 'user123' });
    expect(result.ok).toBe(true);
  });

  it('accepts and trims a valid viewerKey', () => {
    const result = validateParams({ userId: 'user123', viewerKey: '  viewer-123  ' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.viewerKey).toBe('viewer-123');
  });

  it('strictly rejects invalid viewerKey values', () => {
    expect(validateParams({ userId: 'user123', viewerKey: '' }).ok).toBe(false);
    expect(validateParams({ userId: 'user123', viewerKey: '   ' }).ok).toBe(false);
    expect(validateParams({ userId: 'user123', viewerKey: 123 }).ok).toBe(false);
    expect(validateParams({ userId: 'user123', viewerKey: 'x'.repeat(129) }).ok).toBe(false);
    expect(validateParams({ userId: 'user123', viewerKey: 'x'.repeat(128) }).ok).toBe(true);
  });

  it('rejects a missing userId', () => {
    expect(validateParams({ context: {} })).toEqual({
      ok: false,
      error: 'params.userId is required and must be a non-empty string',
    });
  });

  it('rejects a blank userId', () => {
    expect(validateParams({ userId: '   ' }).ok).toBe(false);
  });

  it('rejects a non-string userId', () => {
    expect(validateParams({ userId: 123 }).ok).toBe(false);
  });

  it('rejects non-object params', () => {
    expect(validateParams(null).ok).toBe(false);
    expect(validateParams('nope').ok).toBe(false);
  });

  it('accepts a valid queue name', () => {
    const result = validateParams({ userId: 'u1', queue: 'home' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.queue).toBe('home');
  });

  it('rejects an empty queue string', () => {
    expect(validateParams({ userId: 'u1', queue: '' }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', queue: '   ' }).ok).toBe(false);
  });

  it('accepts a valid skipCheckers array', () => {
    const result = validateParams({ userId: 'u1', skipCheckers: ['limit', 'cooldown'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.skipCheckers).toEqual(['limit', 'cooldown']);
  });

  it('rejects skipCheckers that is not an array of strings', () => {
    expect(validateParams({ userId: 'u1', skipCheckers: 'limit' }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', skipCheckers: [1, 2] }).ok).toBe(false);
  });

  it('rejects an unknown checker name in skipCheckers, listing the allowed names', () => {
    const result = validateParams({ userId: 'u1', skipCheckers: ['nonexistent'] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('nonexistent');
      // The error must enumerate the registered checker names (single source of truth).
      expect(result.error).toContain('limit');
      expect(result.error).toContain('cooldown');
      expect(result.error).toContain('format');
    }
  });

  it('rejects a non-boolean user.authenticated', () => {
    const result = validateParams({ userId: 'u1', user: { authenticated: 'false' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/authenticated must be a boolean/);
    expect(validateParams({ userId: 'u1', user: { authenticated: 1 } }).ok).toBe(false);
  });

  it('rejects a non-boolean user.isAuthorized', () => {
    const result = validateParams({ userId: 'u1', user: { isAuthorized: 'false' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/isAuthorized must be a boolean/);
  });

  it('normalizes the legacy authenticated alias to canonical authorization + identity kind', () => {
    const result = validateParams({ userId: 'u1', user: { authenticated: true } });
    expect(result).toEqual({
      ok: true,
      params: { userId: 'u1', user: { isAuthorized: true, identityKind: 'account' } },
    });
  });

  it('rejects conflicting canonical and legacy authorization flags', () => {
    const result = validateParams({
      userId: 'u1',
      user: { isAuthorized: false, authenticated: true },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/conflicts/);
  });

  it('strictly validates identityKind and rejects authorized anonymous identity', () => {
    expect(validateParams({ userId: 'u1', user: { identityKind: 'device' } }).ok).toBe(false);
    const result = validateParams({
      userId: 'u1',
      user: { isAuthorized: true, identityKind: 'anonymous' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/cannot be 'anonymous'/);
  });

  it('accepts a signed logged-out account identity and keeps authorization false', () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const verifyIdentityProof = (proof: string, sub: string) => proof === 'signed-u1' && sub === userId;
    const result = validateParams({
      userId,
      user: { id: userId, isAuthorized: false, identityKind: 'account', identityProof: 'signed-u1' },
    }, { verifyIdentityProof });
    expect(result).toEqual({
      ok: true,
      params: {
        userId,
        user: { id: userId, isAuthorized: false, identityKind: 'account' },
      },
    });
  });

  it('rejects an explicit account identity without a proof bound to the same user id', () => {
    const verifyIdentityProof = (_proof: string, sub: string) => sub === 'another-user';
    expect(validateParams({
      userId: 'u1',
      user: { isAuthorized: false, identityKind: 'account', identityProof: 'wrong' },
    }, { verifyIdentityProof }).ok).toBe(false);
    expect(validateParams({
      userId: 'u1',
      user: { isAuthorized: true, identityKind: 'account' },
    }).ok).toBe(false);
  });

  it('accepts user.authenticated when boolean or absent', () => {
    expect(validateParams({ userId: 'u1', user: { authenticated: false } }).ok).toBe(true);
    expect(validateParams({ userId: 'u1', user: { id: 'u1' } }).ok).toBe(true);
  });

  it('accepts a valid formats array', () => {
    const result = validateParams({ userId: 'u1', formats: ['popup', 'fullscreen'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.formats).toEqual(['popup', 'fullscreen']);
  });

  it('rejects formats that is not an array of strings', () => {
    expect(validateParams({ userId: 'u1', formats: 'popup' }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', formats: [1, 2] }).ok).toBe(false);
  });

  it('trims formats and omits the field when only empties remain', () => {
    const result = validateParams({ userId: 'u1', formats: ['  topline ', '', '   '] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.formats).toEqual(['topline']);
    const empty = validateParams({ userId: 'u1', formats: ['', '  '] });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.params.formats).toBeUndefined();
  });

  it('accepts a user object', () => {
    const result = validateParams({ userId: 'u1', user: { authenticated: true } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.params.user).toEqual({ isAuthorized: true, identityKind: 'account' });
    }
  });

  it('resolves userId from params.user.id when top-level userId is absent', () => {
    const result = validateParams({ user: { id: 'from-user' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.userId).toBe('from-user');
  });

  it('accepts a valid device', () => {
    for (const device of ['desktop', 'touch'] as const) {
      const result = validateParams({ userId: 'u1', device });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.params.device).toBe(device);
    }
  });

  it('omits device when absent (no device filtering)', () => {
    const result = validateParams({ userId: 'u1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.device).toBeUndefined();
  });

  it('rejects an invalid device value', () => {
    expect(validateParams({ userId: 'u1', device: 'mobile' }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', device: 1 }).ok).toBe(false);
  });

  it('rejects mismatched top-level userId and params.user.id', () => {
    const result = validateParams({ userId: 'top', user: { id: 'inner' } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/must match/);
  });

  it('accepts a valid excludeIds array', () => {
    const result = validateParams({ userId: 'u1', excludeIds: ['cab-onb-0-intro', 'cab-onb-1'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.excludeIds).toEqual(['cab-onb-0-intro', 'cab-onb-1']);
  });

  it('omits excludeIds when absent (no exclusion filtering)', () => {
    const result = validateParams({ userId: 'u1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.excludeIds).toBeUndefined();
  });

  it('rejects excludeIds that is not an array of strings', () => {
    expect(validateParams({ userId: 'u1', excludeIds: 'promo-1' }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', excludeIds: [1, 2] }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', excludeIds: [{ id: 'x' }] }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', excludeIds: [null] }).ok).toBe(false);
  });

  it('rejects an empty-string element in excludeIds', () => {
    const result = validateParams({ userId: 'u1', excludeIds: ['ok', ''] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/excludeIds/);
  });

  it('rejects an excludeIds element longer than 64 characters', () => {
    expect(validateParams({ userId: 'u1', excludeIds: ['a'.repeat(65)] }).ok).toBe(false);
    // 64 chars is the inclusive maximum.
    expect(validateParams({ userId: 'u1', excludeIds: ['a'.repeat(64)] }).ok).toBe(true);
  });

  it('rejects more than 50 excludeIds elements', () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    expect(validateParams({ userId: 'u1', excludeIds: fifty }).ok).toBe(true);
    const result = validateParams({ userId: 'u1', excludeIds: [...fifty, 'one-more'] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/excludeIds/);
  });

  it('accepts an empty excludeIds array (no-op filter)', () => {
    const result = validateParams({ userId: 'u1', excludeIds: [] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.excludeIds).toEqual([]);
  });
  it('accepts a valid env object and passes only known keys through', () => {
    const result = validateParams({ userId: 'u1', env: { os: 'ios', runtime: 'telegram', brand: 'iphone', junk: 'x' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.env).toEqual({ os: 'ios', runtime: 'telegram', brand: 'iphone' });
  });

  it('accepts a partial env (только runtime)', () => {
    const result = validateParams({ userId: 'u1', env: { runtime: 'browser' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.env).toEqual({ runtime: 'browser' });
  });

  it('omits env when absent or carrying no known keys (back-compat)', () => {
    const absent = validateParams({ userId: 'u1' });
    expect(absent.ok).toBe(true);
    if (absent.ok) expect(absent.params.env).toBeUndefined();
    const junkOnly = validateParams({ userId: 'u1', env: { junk: 1 } });
    expect(junkOnly.ok).toBe(true);
    if (junkOnly.ok) expect(junkOnly.params.env).toBeUndefined();
  });

  it('rejects env that is not an object', () => {
    const result = validateParams({ userId: 'u1', env: 'ios' });
    expect(result).toEqual({ ok: false, error: 'params.env must be an object' });
  });

  it('rejects env.os outside the enum', () => {
    const result = validateParams({ userId: 'u1', env: { os: 'windows' } });
    expect(result).toEqual({ ok: false, error: "params.env.os must be 'ios' or 'android'" });
  });

  it('rejects env.runtime outside the enum', () => {
    const result = validateParams({ userId: 'u1', env: { runtime: 'webview' } });
    expect(result).toEqual({ ok: false, error: "params.env.runtime must be 'browser', 'telegram', 'pwa' or 'app'" });
  });

  it('rejects env.brand outside the enum', () => {
    const result = validateParams({ userId: 'u1', env: { brand: 'nokia' } });
    expect(result).toEqual({ ok: false, error: "params.env.brand must be 'iphone', 'android-flagship' or 'android-other'" });
  });

  it("accepts skipCheckers ['env'] — allowlist расширился автоматически", () => {
    const result = validateParams({ userId: 'u1', skipCheckers: ['env'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.skipCheckers).toEqual(['env']);
  });
});

describe('params.geo (IP-geo, WS-2)', () => {
  it('accepts a valid geo with and without city', () => {
    for (const geo of [{ segment: 'tourist' }, { segment: 'local', city: 'gagra' }]) {
      const result = validateParams({ userId: 'u1', geo });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.params.geo).toEqual(geo);
    }
  });

  it('omits geo when absent (back-compat, no geo filtering)', () => {
    const result = validateParams({ userId: 'u1' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.geo).toBeUndefined();
  });

  it('rejects garbage: non-object, unknown segment, bad city', () => {
    expect(validateParams({ userId: 'u1', geo: 'tourist' }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', geo: ['tourist'] }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', geo: { segment: 'moon' } }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', geo: { city: 'sochi' } }).ok).toBe(false); // segment обязателен
    expect(validateParams({ userId: 'u1', geo: { segment: 'local', city: '' } }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', geo: { segment: 'local', city: 'x'.repeat(65) } }).ok).toBe(false);
  });

  it('does not forward extra keys inside geo', () => {
    const result = validateParams({ userId: 'u1', geo: { segment: 'other', junk: 1 } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.geo).toEqual({ segment: 'other' });
  });

  it("skipCheckers allowlist auto-includes 'geo'", () => {
    const result = validateParams({ userId: 'u1', skipCheckers: ['geo'] });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.skipCheckers).toEqual(['geo']);
  });
});

describe('params.visit (visit-profile, WS-4)', () => {
  it('accepts and canonicalizes a full visit object', () => {
    const r = validateParams({ userId: 'u1', visit: { source: 'telegram', firstSeenDaysAgo: 3, visitDays: 6, junk: 'x' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.visit).toEqual({ source: 'telegram', firstSeenDaysAgo: 3, visitDays: 6 });
  });

  it('accepts partial visit and omits an empty one', () => {
    const partial = validateParams({ userId: 'u1', visit: { visitDays: 2 } });
    expect(partial.ok).toBe(true);
    if (partial.ok) expect(partial.params.visit).toEqual({ visitDays: 2 });
    const empty = validateParams({ userId: 'u1', visit: {} });
    expect(empty.ok).toBe(true);
    if (empty.ok) expect(empty.params.visit).toBeUndefined();
  });

  it('omitting visit entirely is fine (back-compat)', () => {
    const r = validateParams({ userId: 'u1' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.visit).toBeUndefined();
  });

  it('rejects a non-object, bad enum, fractional/negative/huge days', () => {
    expect(validateParams({ userId: 'u1', visit: 'telegram' }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', visit: ['telegram'] }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', visit: { source: 'vk' } }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', visit: { firstSeenDaysAgo: 1.5 } }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', visit: { visitDays: -1 } }).ok).toBe(false);
    expect(validateParams({ userId: 'u1', visit: { visitDays: 10_001 } }).ok).toBe(false);
  });

  it("skipCheckers allowlist auto-includes 'visitor' and 'source'", () => {
    expect(validateParams({ userId: 'u1', skipCheckers: ['visitor', 'source'] }).ok).toBe(true);
  });
});
