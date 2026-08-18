import { Checker, type CheckContext, type SuppliersData } from '../Checker';

export const DEFAULT_NEWCOMER_MAX_AGE_DAYS = 7;
export const DEFAULT_REGULAR_MIN_VISIT_DAYS = 5;

/** Профиль визита: newcomer (молодой аккаунт/браузер) или regular (заходит часто).
 *  Fail closed: правило задано, сигнала нет → false (как age в TargetingChecker). */
export class VisitorChecker extends Checker<'userData'> {
  readonly name = 'visitor';
  readonly requiredSupplierIDs = ['userData'] as const;
  expect() { return 'user matches the promo visitorClass (newcomer/regular) rule'; }
  shouldSkip(ctx: CheckContext): false | string {
    return ctx.promo.targeting.visitorClass === undefined ? 'no visitor rule' : false;
  }
  check(ctx: CheckContext, data: SuppliersData<'userData'>): boolean {
    const t = ctx.promo.targeting;
    if (t.visitorClass === 'newcomer') {
      const maxDays = t.newcomerMaxAgeDays ?? DEFAULT_NEWCOMER_MAX_AGE_DAYS;
      // account → возраст аккаунта; иначе (anonymous / identityKind не доехал) →
      // возраст браузерного профиля. Смешивать сигналы нельзя: у залогиненного
      // старый браузер не должен прятать молодой аккаунт и наоборот.
      const ageDays = ctx.identityKind === 'account'
        ? data.userData.accountAgeDays
        : ctx.visit?.firstSeenDaysAgo;
      return ageDays !== undefined && ageDays <= maxDays;
    }
    const minDays = t.regularMinVisitDays ?? DEFAULT_REGULAR_MIN_VISIT_DAYS;
    const visitDays = ctx.visit?.visitDays;
    return visitDays !== undefined && visitDays >= minDays;
  }
}
