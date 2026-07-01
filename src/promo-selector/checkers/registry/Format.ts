import { Checker, type CheckContext } from '../Checker';

/**
 * Gates a promo to the creative formats the requesting SURFACE can render.
 *
 * With per-catalog queues, one queue (e.g. `transport`) holds promos of several
 * formats; the surface (topline / overlay / tooltip) passes `ctx.formats` so it
 * pulls only what it can show. A no-op when the request carries no `formats`
 * (back-compat: before per-catalog queues, one queue == one format-family, so
 * surface separation lived at the queue level and no format filter was needed).
 *
 * Distinct from DeviceChecker, which drops formats the DEVICE can't render; this
 * drops formats the SURFACE didn't ask for.
 */
export class FormatChecker extends Checker {
  readonly name = 'format';
  expect() { return 'promo.format is one of the formats the requesting surface accepts'; }
  shouldSkip(ctx: CheckContext): false | string {
    if (ctx.formats === undefined || ctx.formats.length === 0) return 'no format filter in context';
    return false;
  }
  check(ctx: CheckContext): boolean {
    return ctx.formats!.includes(ctx.promo.format);
  }
}
