import { Checker, type CheckContext } from '../Checker';

/** Gates a promo to authenticated-only or anonymous-only audiences. */
export class AudienceChecker extends Checker {
  readonly name = 'audience';
  expect() { return 'user matches the promo audience gate'; }
  shouldSkip(ctx: CheckContext): false | string {
    const a = ctx.promo.audience;
    return a === undefined || a === 'all' ? 'no audience gate' : false;
  }
  check(ctx: CheckContext): boolean {
    if (ctx.promo.audience === 'authenticated') return ctx.authenticated === true;
    return ctx.authenticated !== true; // 'anonymous'
  }
}
