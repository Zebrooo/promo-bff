import { describe, it, expect } from 'vitest';
import { validateEnhanceParams, filterPagesAgainstWhitelist, validateCpmRange } from './validate';

describe('validateEnhanceParams', () => {
  it('accepts a minimal valid body with just title', () => {
    const r = validateEnhanceParams({ advertiserId: 'adv1', draft: { title: 'Привет' } });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params).toEqual({ advertiserId: 'adv1', draft: { title: 'Привет' } });
  });

  it('accepts description-only and action.label-only drafts', () => {
    expect(validateEnhanceParams({ advertiserId: 'a', draft: { description: 'd' } }).ok).toBe(true);
    expect(validateEnhanceParams({ advertiserId: 'a', draft: { action: { label: 'L' } } }).ok).toBe(true);
  });

  it('preserves opaque extra draft fields untouched', () => {
    const r = validateEnhanceParams({
      advertiserId: 'a',
      draft: { title: 'x', format: 'popup', backgroundColor: '#fff' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.draft.format).toBe('popup');
      expect(r.params.draft.backgroundColor).toBe('#fff');
    }
  });

  it.each([null, undefined, 42, 'str', []])('rejects non-object bodies (%s)', (body) => {
    const r = validateEnhanceParams(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/object/);
  });

  it('rejects missing/empty advertiserId', () => {
    expect(validateEnhanceParams({ draft: { title: 'x' } }).ok).toBe(false);
    expect(validateEnhanceParams({ advertiserId: '', draft: { title: 'x' } }).ok).toBe(false);
    expect(validateEnhanceParams({ advertiserId: '   ', draft: { title: 'x' } }).ok).toBe(false);
  });

  it('rejects missing or wrongly-typed draft', () => {
    expect(validateEnhanceParams({ advertiserId: 'a' }).ok).toBe(false);
    expect(validateEnhanceParams({ advertiserId: 'a', draft: null }).ok).toBe(false);
    expect(validateEnhanceParams({ advertiserId: 'a', draft: 'oops' }).ok).toBe(false);
    expect(validateEnhanceParams({ advertiserId: 'a', draft: ['arr'] }).ok).toBe(false);
  });

  it('rejects wrongly-typed text fields', () => {
    expect(validateEnhanceParams({ advertiserId: 'a', draft: { title: 5 } }).ok).toBe(false);
    expect(validateEnhanceParams({ advertiserId: 'a', draft: { description: {} } }).ok).toBe(false);
    expect(validateEnhanceParams({ advertiserId: 'a', draft: { action: 'bad' } }).ok).toBe(false);
    expect(validateEnhanceParams({ advertiserId: 'a', draft: { action: { label: 42 } } }).ok).toBe(false);
  });

  it('rejects a draft with no non-empty improvable fields', () => {
    const r = validateEnhanceParams({ advertiserId: 'a', draft: { title: '   ', description: '' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at least one/);
  });
});

describe('filterPagesAgainstWhitelist', () => {
  it('keeps keys that are in whitelist', () => {
    const allowed = [{ key: 'home', name: 'Home' }, { key: 'auto', name: 'Auto' }];
    expect(filterPagesAgainstWhitelist(['home', 'auto'], allowed)).toEqual(['home', 'auto']);
  });

  it('drops keys NOT in whitelist', () => {
    const allowed = [{ key: 'home', name: 'Home' }];
    expect(filterPagesAgainstWhitelist(['home', 'mystery'], allowed)).toEqual(['home']);
  });

  it('returns empty array when nothing matches', () => {
    expect(filterPagesAgainstWhitelist(['x', 'y'], [{ key: 'home', name: 'Home' }])).toEqual([]);
  });

  it('handles empty input', () => {
    expect(filterPagesAgainstWhitelist([], [{ key: 'home', name: 'Home' }])).toEqual([]);
  });

  it('handles empty whitelist (drops everything)', () => {
    expect(filterPagesAgainstWhitelist(['home'], [])).toEqual([]);
  });

  it('dedupes repeated keys', () => {
    const allowed = [{ key: 'home', name: 'Home' }];
    expect(filterPagesAgainstWhitelist(['home', 'home', 'home'], allowed)).toEqual(['home']);
  });
});

describe('validateCpmRange', () => {
  it('accepts 1 (lower bound)', () => { expect(validateCpmRange(1)).toBe(true); });
  it('accepts 500 (upper bound)', () => { expect(validateCpmRange(500)).toBe(true); });
  it('accepts 50 (mid-range)', () => { expect(validateCpmRange(50)).toBe(true); });
  it('accepts 135 (premium config)', () => { expect(validateCpmRange(135)).toBe(true); });
  it('rejects 0', () => { expect(validateCpmRange(0)).toBe(false); });
  it('rejects 0.5', () => { expect(validateCpmRange(0.5)).toBe(false); });
  it('rejects 501', () => { expect(validateCpmRange(501)).toBe(false); });
  it('rejects 999', () => { expect(validateCpmRange(999)).toBe(false); });
  it('rejects NaN', () => { expect(validateCpmRange(NaN)).toBe(false); });
  it('rejects Infinity', () => { expect(validateCpmRange(Infinity)).toBe(false); });
  it('rejects negative', () => { expect(validateCpmRange(-1)).toBe(false); });
});

describe('validateEnhanceParams (availablePages)', () => {
  const baseValid = { advertiserId: 'a', draft: { title: 't' } };

  it('accepts request without availablePages (back-compat)', () => {
    const r = validateEnhanceParams(baseValid);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.availablePages).toBeUndefined();
  });

  it('accepts request with valid availablePages', () => {
    const r = validateEnhanceParams({ ...baseValid, availablePages: [{ key: 'home', name: 'Главная' }] });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.availablePages).toEqual([{ key: 'home', name: 'Главная' }]);
  });

  it('rejects availablePages that is not an array', () => {
    const r = validateEnhanceParams({ ...baseValid, availablePages: 'oops' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/availablePages/);
  });

  it('rejects availablePages item missing key', () => {
    const r = validateEnhanceParams({ ...baseValid, availablePages: [{ name: 'x' }] });
    expect(r.ok).toBe(false);
  });

  it('rejects availablePages item missing name', () => {
    const r = validateEnhanceParams({ ...baseValid, availablePages: [{ key: 'x' }] });
    expect(r.ok).toBe(false);
  });
});
