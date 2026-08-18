import { Checker, type CheckContext } from '../Checker';

/** Источник захода текущей сессии (aa_src, свёрнут сайтом до 1 из 4 классов).
 *  Fail closed: правило задано, сигнала нет → false. */
export class SourceChecker extends Checker {
  readonly name = 'source';
  expect() { return 'session entry source is in the promo entrySources list'; }
  shouldSkip(ctx: CheckContext): false | string {
    return (ctx.promo.entrySources?.length ?? 0) > 0 ? false : 'no entry-source rule';
  }
  check(ctx: CheckContext): boolean {
    const source = ctx.visit?.source;
    return source !== undefined && (ctx.promo.entrySources ?? []).includes(source);
  }
}
