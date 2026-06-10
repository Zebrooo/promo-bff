import { Checker, type CheckContext } from '../Checker';

/** Gates a promo to specific page sections/categories. Reads the request context. */
export class ContextChecker extends Checker {
  readonly name = 'context';
  expect() { return 'page section/category is in the promo allow-list'; }
  shouldSkip(ctx: CheckContext): false | string {
    const { sections, categories } = ctx.promo;
    const hasRule = (sections?.length ?? 0) > 0 || (categories?.length ?? 0) > 0;
    return hasRule ? false : 'no section/category gate';
  }
  check(ctx: CheckContext): boolean {
    const { sections, categories } = ctx.promo;
    if (sections?.length) {
      if (ctx.section === undefined || !sections.includes(ctx.section)) return false;
    }
    if (categories?.length) {
      if (ctx.category === undefined || !categories.includes(ctx.category)) return false;
    }
    return true;
  }
}
