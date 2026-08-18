import { Checker, type CheckContext } from '../Checker';

/** IP-geo gate: где пользователь СЕЙЧАС (segment/city, разрезолвленные сайтом).
 *  Ось targeting.regions (город из ПРОФИЛЯ) не трогает — это другая ось.
 *  Fail-closed: правило задано, а сигнала нет (VPN/нет mmdb/приватный IP) → промо
 *  не показывается; остальная очередь не затронута. */
export class GeoChecker extends Checker {
  readonly name = 'geo';
  expect() { return 'viewer IP-geo matches geoSegments/geoCities targeting'; }
  shouldSkip(ctx: CheckContext): false | string {
    const t = ctx.promo.targeting;
    const hasRules = (t.geoSegments?.length ?? 0) > 0 || (t.geoCities?.length ?? 0) > 0;
    return hasRules ? false : 'no geo rules';
  }
  check(ctx: CheckContext): boolean {
    const t = ctx.promo.targeting;
    // Правило есть, сигнала нет → fail-closed (как age-gate в TargetingChecker).
    if (ctx.geoSegment === undefined) return false;
    if (t.geoSegments?.length && !t.geoSegments.includes(ctx.geoSegment)) return false;
    if (t.geoCities?.length && (ctx.geoCity === undefined || !t.geoCities.includes(ctx.geoCity))) return false;
    return true;
  }
}
