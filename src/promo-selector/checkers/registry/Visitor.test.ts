import { describe, expect, it } from 'vitest';
import { VisitorChecker, DEFAULT_NEWCOMER_MAX_AGE_DAYS, DEFAULT_REGULAR_MIN_VISIT_DAYS } from './Visitor';
import { makeCheckContext, makePromo, makeSuppliers } from '../../../test-utils';

const c = new VisitorChecker();
const newcomerPromo = (days?: number) =>
  makePromo({ targeting: { visitorClass: 'newcomer', ...(days !== undefined ? { newcomerMaxAgeDays: days } : {}) } });
const regularPromo = (days?: number) =>
  makePromo({ targeting: { visitorClass: 'regular', ...(days !== undefined ? { regularMinVisitDays: days } : {}) } });

describe('VisitorChecker', () => {
  it('skips when the promo has no visitorClass', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ targeting: { minAge: 18 } }) }))).toBe('no visitor rule');
    expect(c.shouldSkip(makeCheckContext({ promo: newcomerPromo() }))).toBe(false);
  });

  describe('newcomer / account identity — по возрасту аккаунта', () => {
    const ctx = (accountAgeDays?: number) =>
      [makeCheckContext({ promo: newcomerPromo(), identityKind: 'account' }), makeSuppliers({ accountAgeDays })] as const;
    it('younger than the default 7 days → pass; exactly N → pass; older → fail', () => {
      expect(c.check(...ctx(3))).toBe(true);
      expect(c.check(...ctx(DEFAULT_NEWCOMER_MAX_AGE_DAYS))).toBe(true);
      expect(c.check(...ctx(8))).toBe(false);
    });
    it('custom threshold wins over the default', () => {
      expect(c.check(makeCheckContext({ promo: newcomerPromo(30), identityKind: 'account' }), makeSuppliers({ accountAgeDays: 20 }))).toBe(true);
      expect(c.check(makeCheckContext({ promo: newcomerPromo(2), identityKind: 'account' }), makeSuppliers({ accountAgeDays: 3 }))).toBe(false);
    });
    it('accountAgeDays undefined → fail closed (даже при свежей aa_first_seen)', () => {
      expect(c.check(
        makeCheckContext({ promo: newcomerPromo(), identityKind: 'account', visit: { firstSeenDaysAgo: 0 } }),
        makeSuppliers({ accountAgeDays: undefined }),
      )).toBe(false);
    });
  });

  describe('newcomer / anonymous — по aa_first_seen', () => {
    it('firstSeenDaysAgo ≤ N → pass, > N → fail, отсутствует → fail closed', () => {
      const suppliers = makeSuppliers({ accountAgeDays: undefined });
      expect(c.check(makeCheckContext({ promo: newcomerPromo(), identityKind: 'anonymous', visit: { firstSeenDaysAgo: 7 } }), suppliers)).toBe(true);
      expect(c.check(makeCheckContext({ promo: newcomerPromo(), identityKind: 'anonymous', visit: { firstSeenDaysAgo: 8 } }), suppliers)).toBe(false);
      expect(c.check(makeCheckContext({ promo: newcomerPromo(), identityKind: 'anonymous', visit: {} }), suppliers)).toBe(false);
      expect(c.check(makeCheckContext({ promo: newcomerPromo(), identityKind: 'anonymous' }), suppliers)).toBe(false);
    });
  });

  describe('regular — по aa_visit_days, не зависит от identityKind', () => {
    it('visitDays ≥ M → pass; ровно M → pass; меньше/нет → fail', () => {
      const suppliers = makeSuppliers({});
      expect(c.check(makeCheckContext({ promo: regularPromo(), visit: { visitDays: 9 } }), suppliers)).toBe(true);
      expect(c.check(makeCheckContext({ promo: regularPromo(), visit: { visitDays: DEFAULT_REGULAR_MIN_VISIT_DAYS } }), suppliers)).toBe(true);
      expect(c.check(makeCheckContext({ promo: regularPromo(), visit: { visitDays: 4 } }), suppliers)).toBe(false);
      expect(c.check(makeCheckContext({ promo: regularPromo() }), suppliers)).toBe(false);
      expect(c.check(makeCheckContext({ promo: regularPromo(3), visit: { visitDays: 3 }, identityKind: 'account' }), suppliers)).toBe(true);
    });
  });
});
