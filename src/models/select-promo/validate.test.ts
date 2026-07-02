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
      expect(result.params.user?.authenticated).toBe(true);
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

  it('top-level userId takes precedence over params.user.id', () => {
    const result = validateParams({ userId: 'top', user: { id: 'inner' } });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.params.userId).toBe('top');
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
});
