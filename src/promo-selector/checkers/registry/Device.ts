import { Checker, type CheckContext } from '../Checker';
import type { PromoFormat } from '../../types';

/**
 * Formats the renderer only supports on desktop. MUST mirror FORMATS_BY_DEVICE in
 * @zebrooo/promo-renderer (src/model.ts): touch = inline|popup|fullscreen|divkit,
 * desktop additionally = topline|tooltip. Keep in sync when the renderer's device
 * matrix changes. On touch these formats render to nothing, so we drop such promos
 * server-side and let select-promo fall through to the next eligible promo —
 * otherwise a desktop-only promo at the queue head = empty slot with no fallback.
 */
const DESKTOP_ONLY_FORMATS: ReadonlySet<PromoFormat> = new Set<PromoFormat>(['topline', 'tooltip']);

/**
 * Gates a promo to the requesting device, two ways:
 *   1. the advertiser's explicit `deviceTarget` ('desktop'/'touch'/'both'), and
 *   2. whether the promo's `format` can render on that device at all.
 * Reads `ctx.device`; a no-op when the request carries no device (back-compat —
 * gating then stays client-side in the renderer).
 */
export class DeviceChecker extends Checker {
  readonly name = 'device';
  expect() { return 'promo deviceTarget and format are compatible with the request device'; }
  shouldSkip(ctx: CheckContext): false | string {
    if (ctx.device === undefined) return 'no device in context';
    return false;
  }
  check(ctx: CheckContext): boolean {
    const { deviceTarget, format } = ctx.promo;
    // 1. Explicit advertiser device gate.
    if (deviceTarget !== undefined && deviceTarget !== 'both' && deviceTarget !== ctx.device) {
      return false;
    }
    // 2. Format capability gate: a touch device can't render desktop-only formats.
    if (ctx.device === 'touch' && DESKTOP_ONLY_FORMATS.has(format)) {
      return false;
    }
    return true;
  }
}
