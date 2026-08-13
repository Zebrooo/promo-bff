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
  it('accepts mixed exposure with a normalized sequence group', () => {
    const r = validateAuctionParams({
      slots: [
        { slot: 'hero-static', weight: 1 },
        { slot: 'hero-slide-1', weight: 2, sequenceGroup: '  home-hero  ' },
        { slot: 'hero-slide-2', weight: 3, sequenceGroup: 'home-hero' },
      ],
      exposure: 'mixed',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.exposure).toBe('mixed');
      expect(r.params.slots[0]).not.toHaveProperty('sequenceGroup');
      expect(r.params.slots[1]?.sequenceGroup).toBe('home-hero');
      expect(r.params.slots[2]?.sequenceGroup).toBe('home-hero');
    }
  });
  it('accepts a normalized co-display group with normal and singleton sizes', () => {
    const r = validateAuctionParams({
      slots: [{
        slot: 'home-top-left',
        weight: 1,
        format: 'horizontal',
        width: 580,
        height: 120,
        singletonWidth: 1200,
        singletonHeight: 150,
        coDisplayGroup: '  desktop-top  ',
      }],
      exposure: 'mixed',
    });

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.params.slots[0]).toEqual({
        slot: 'home-top-left',
        weight: 1,
        format: 'horizontal',
        width: 580,
        height: 120,
        singletonWidth: 1200,
        singletonHeight: 150,
        coDisplayGroup: 'desktop-top',
      });
    }
  });
  it('rejects sequenceGroup unless exposure is mixed', () => {
    const slot = { slot: 'x', weight: 1, sequenceGroup: 'hero' };

    expect(validateAuctionParams({ slots: [slot] }).ok).toBe(false);
    expect(validateAuctionParams({ slots: [slot], exposure: 'simultaneous' }).ok).toBe(false);
    expect(validateAuctionParams({ slots: [slot], exposure: 'sequence' }).ok).toBe(false);
  });
  it('rejects coDisplayGroup unless exposure is mixed', () => {
    const slot = { slot: 'x', weight: 1, coDisplayGroup: 'desktop-top' };

    expect(validateAuctionParams({ slots: [slot] }).ok).toBe(false);
    expect(validateAuctionParams({ slots: [slot], exposure: 'simultaneous' }).ok).toBe(false);
    expect(validateAuctionParams({ slots: [slot], exposure: 'sequence' }).ok).toBe(false);
  });
  it('rejects mixed exposure without any group', () => {
    expect(validateAuctionParams({
      slots: [{ slot: 'x', weight: 1 }],
      exposure: 'mixed',
    }).ok).toBe(false);
  });
  it('rejects a slot belonging to both sequence and co-display groups', () => {
    expect(validateAuctionParams({
      slots: [{ slot: 'x', weight: 1, sequenceGroup: 'hero', coDisplayGroup: 'hero' }],
      exposure: 'mixed',
    }).ok).toBe(false);
  });
  it('rejects invalid or overlong sequence groups after trimming', () => {
    const validateGroup = (sequenceGroup: unknown) => validateAuctionParams({
      slots: [{ slot: 'x', weight: 1, sequenceGroup }],
      exposure: 'mixed',
    });

    expect(validateGroup(5).ok).toBe(false);
    expect(validateGroup('   ').ok).toBe(false);
    expect(validateGroup(` ${'g'.repeat(128)} `).ok).toBe(true);
    expect(validateGroup(` ${'g'.repeat(129)} `).ok).toBe(false);
  });
  it('rejects invalid or overlong co-display groups after trimming', () => {
    const validateGroup = (coDisplayGroup: unknown) => validateAuctionParams({
      slots: [{ slot: 'x', weight: 1, coDisplayGroup }],
      exposure: 'mixed',
    });

    expect(validateGroup(5).ok).toBe(false);
    expect(validateGroup('   ').ok).toBe(false);
    expect(validateGroup(` ${'g'.repeat(128)} `).ok).toBe(true);
    expect(validateGroup(` ${'g'.repeat(129)} `).ok).toBe(false);
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

  it('rejects malformed or out-of-scope singleton size pairs', () => {
    const grouped = {
      slot: 'x',
      weight: 1,
      width: 580,
      height: 120,
      coDisplayGroup: 'desktop-top',
    };
    const validateMixed = (slot: Record<string, unknown>) => validateAuctionParams({
      slots: [slot],
      exposure: 'mixed',
    });

    expect(validateMixed({ ...grouped, singletonWidth: 1200 }).ok).toBe(false);
    expect(validateMixed({ ...grouped, singletonHeight: 150 }).ok).toBe(false);
    expect(validateMixed({ ...grouped, singletonWidth: 1200.5, singletonHeight: 150 }).ok).toBe(false);
    expect(validateMixed({ ...grouped, singletonWidth: 0, singletonHeight: 150 }).ok).toBe(false);
    expect(validateMixed({ ...grouped, singletonWidth: 10_001, singletonHeight: 150 }).ok).toBe(false);
    expect(validateMixed({ ...grouped, singletonWidth: '1200', singletonHeight: 150 }).ok).toBe(false);
    expect(validateMixed({
      slot: 'x',
      weight: 1,
      coDisplayGroup: 'desktop-top',
      singletonWidth: 1200,
      singletonHeight: 150,
    }).ok).toBe(false);
    expect(validateAuctionParams({
      slots: [{
        slot: 'x',
        weight: 1,
        width: 580,
        height: 120,
        sequenceGroup: 'hero',
        singletonWidth: 1200,
        singletonHeight: 150,
      }],
      exposure: 'mixed',
    }).ok).toBe(false);
    expect(validateAuctionParams({
      slots: [{ ...grouped, singletonWidth: 1200, singletonHeight: 150 }],
      exposure: 'simultaneous',
    }).ok).toBe(false);
  });
});
