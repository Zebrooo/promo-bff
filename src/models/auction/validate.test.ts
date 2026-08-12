import { describe, expect, it } from 'vitest';
import { validateAuctionParams } from './validate';

describe('validateAuctionParams', () => {
  it('accepts a slots array of {slot, weight}', () => {
    const r = validateAuctionParams({ slots: [{ slot: 'home-top-1', weight: 1 }, { slot: 'home-side-2', weight: 4 }] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.slots.length).toBe(2);
      expect(r.params.exposure).toBe('simultaneous');
    }
  });
  it('accepts sequence exposure and rejects unknown exposure', () => {
    const r = validateAuctionParams({ slots: [{ slot: 'x', weight: 1 }], exposure: 'sequence' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.params.exposure).toBe('sequence');

    expect(validateAuctionParams({ slots: [{ slot: 'x', weight: 1 }], exposure: 'carousel' }).ok).toBe(false);
  });
  it('rejects an empty or missing slots array', () => {
    expect(validateAuctionParams({}).ok).toBe(false);
    expect(validateAuctionParams({ slots: [] }).ok).toBe(false);
  });
  it('rejects a slot entry with a non-numeric weight or blank slot', () => {
    expect(validateAuctionParams({ slots: [{ slot: '', weight: 1 }] }).ok).toBe(false);
    expect(validateAuctionParams({ slots: [{ slot: 'x', weight: 'hi' }] }).ok).toBe(false);
  });
  it('accepts optional userId and authenticated', () => {
    const r = validateAuctionParams({ slots: [{ slot: 'x', weight: 1 }], userId: 'u1', authenticated: true });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.params.userId).toBe('u1'); expect(r.params.authenticated).toBe(true); }
  });
  it('rejects a non-object body', () => {
    expect(validateAuctionParams(null).ok).toBe(false);
    expect(validateAuctionParams('x').ok).toBe(false);
  });
  it('accepts optional page and per-slot format', () => {
    const r = validateAuctionParams({ slots: [{ slot: 'rail', weight: 1, format: 'vertical' }], page: 'catalog-transport' });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.params.page).toBe('catalog-transport'); expect(r.params.slots[0]!.format).toBe('vertical'); }
  });
  it('rejects a non-string page or slot.format', () => {
    expect(validateAuctionParams({ slots: [{ slot: 'x', weight: 1 }], page: 5 }).ok).toBe(false);
    expect(validateAuctionParams({ slots: [{ slot: 'x', weight: 1, format: 9 }] }).ok).toBe(false);
  });

  it('accepts and preserves a positive bounded width+height pair', () => {
    const r = validateAuctionParams({
      slots: [{ slot: 'home-top-1', weight: 1, format: 'horizontal', width: 580, height: 120 }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.slots[0]).toEqual({
        slot: 'home-top-1',
        weight: 1,
        format: 'horizontal',
        width: 580,
        height: 120,
      });
    }
  });

  it('rejects partial, non-integer, non-positive, and unbounded slot sizes', () => {
    expect(validateAuctionParams({ slots: [{ slot: 'x', weight: 1, width: 580 }] }).ok).toBe(false);
    expect(validateAuctionParams({ slots: [{ slot: 'x', weight: 1, height: 120 }] }).ok).toBe(false);
    expect(validateAuctionParams({ slots: [{ slot: 'x', weight: 1, width: 580.5, height: 120 }] }).ok).toBe(false);
    expect(validateAuctionParams({ slots: [{ slot: 'x', weight: 1, width: 0, height: 120 }] }).ok).toBe(false);
    expect(validateAuctionParams({ slots: [{ slot: 'x', weight: 1, width: 10_001, height: 120 }] }).ok).toBe(false);
    expect(validateAuctionParams({ slots: [{ slot: 'x', weight: 1, width: '580', height: 120 }] }).ok).toBe(false);
  });
});
