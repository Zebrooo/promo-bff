import { Checker, type CheckContext } from '../Checker';

/** Чистый чекер без supplier'ов и запросов: sessionViews пришёл в params сайта
 *  (кука aa_sess_views; перерыв > 30 минут = новый визит). */
export class EngagementChecker extends Checker {
  readonly name = 'engagement';

  expect() {
    return 'viewer opened enough listing cards this visit';
  }

  shouldSkip(ctx: CheckContext): false | string {
    return ctx.promo.targeting.behavior?.minSessionViews !== undefined
      ? false
      : 'no engagement targeting';
  }

  check(ctx: CheckContext): boolean {
    const min = ctx.promo.targeting.behavior?.minSessionViews;
    // Рукописный minSessionViews: 0 — невалидное правило, не «пропустить всех».
    if (typeof min !== 'number' || !Number.isInteger(min) || min < 1) return false;
    return typeof ctx.sessionViews === 'number' && ctx.sessionViews >= min;
  }
}
