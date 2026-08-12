import { Checker, type CheckContext } from '../Checker';

/** Gates a promo by current login state only, never by datasource identity. */
export class AudienceChecker extends Checker {
  readonly name = 'audience';
  expect() { return 'user matches the promo audience gate'; }
  shouldSkip(ctx: CheckContext): false | string {
    const a = ctx.promo.audience;
    return a === undefined || a === 'all' ? 'no audience gate' : false;
  }
  check(ctx: CheckContext): boolean {
    if (ctx.promo.audience === 'authenticated') return ctx.isAuthorized === true;
    return ctx.isAuthorized !== true; // 'anonymous'
  }
}
