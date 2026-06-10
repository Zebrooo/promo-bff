import { afterEach, describe, expect, it, vi } from 'vitest';
import { createUserService, ageFromBirthdate, UNKNOWN_REGION } from './user-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };
const NOW = new Date('2026-05-27T00:00:00Z');

afterEach(() => vi.restoreAllMocks());
function mockFetch(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response));
}

describe('ageFromBirthdate', () => {
  it('computes full-year age (birthday already passed this year)', () => {
    expect(ageFromBirthdate('2000-01-01', NOW)).toBe(26);
  });
  it('does not count a birthday later this year', () => {
    expect(ageFromBirthdate('2000-12-31', NOW)).toBe(25);
  });
  it('counts a birthday that is today', () => {
    expect(ageFromBirthdate('2006-05-27', NOW)).toBe(20);
  });
  it('returns undefined for null / empty / unparseable / future', () => {
    expect(ageFromBirthdate(null, NOW)).toBeUndefined();
    expect(ageFromBirthdate('', NOW)).toBeUndefined();
    expect(ageFromBirthdate('not-a-date', NOW)).toBeUndefined();
    expect(ageFromBirthdate('2030-01-01', NOW)).toBeUndefined();
  });
});

describe('createUserService', () => {
  it('reads city as region and computes age from birthdate', async () => {
    mockFetch(200, [{ city: 'gagra', birthdate: '2000-01-01' }]);
    const p = await createUserService(cfg).getUserProfile('u1');
    expect(p.userId).toBe('u1');
    expect(p.region).toBe('gagra');
    expect(typeof p.age).toBe('number'); // exact value tracks today; ageFromBirthdate is tested deterministically above
  });
  it('age is undefined when birthdate is null', async () => {
    mockFetch(200, [{ city: 'gagra', birthdate: null }]);
    expect(await createUserService(cfg).getUserProfile('u1')).toEqual({ userId: 'u1', age: undefined, region: 'gagra' });
  });
  it('returns region-only default (age undefined) for a missing row', async () => {
    mockFetch(200, []);
    expect(await createUserService(cfg).getUserProfile('anon')).toEqual({ userId: 'anon', region: UNKNOWN_REGION });
  });
  it('returns default (age undefined) when unconfigured (no query)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(await createUserService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).getUserProfile('u1')).toEqual({ userId: 'u1', region: UNKNOWN_REGION });
    expect(f).not.toHaveBeenCalled();
  });
  it('throws on a query failure', async () => {
    mockFetch(500, {});
    await expect(createUserService(cfg).getUserProfile('u1')).rejects.toThrow(/HTTP 500/);
  });
});
