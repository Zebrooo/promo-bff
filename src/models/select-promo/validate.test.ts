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
});
