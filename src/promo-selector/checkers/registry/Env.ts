import { Checker, type CheckContext } from '../Checker';

/**
 * Gates a promo by the request's EXECUTION environment: OS (ios/android),
 * runtime (browser/telegram/pwa/app) and device-brand class (payment-capacity
 * proxy). Каждая ось — OR внутри массива, оси между собой — AND.
 *
 * Намеренное отличие от DeviceChecker (который no-op'ится без ctx.device):
 * при ЗАДАННЫХ правилах отсутствие сигнала по оси — это FAIL, не skip
 * (та же семантика, что ageGated в TargetingChecker). select-promo при этом
 * проваливается к следующему кандидату очереди — слот не пустеет.
 */
export class EnvChecker extends Checker {
  readonly name = 'env';
  expect() { return 'viewer os/environment/device-brand matches promo targeting'; }
  shouldSkip(ctx: CheckContext): false | string {
    const t = ctx.promo.targeting;
    const hasRules =
      (t.os?.length ?? 0) > 0 ||
      (t.environments?.length ?? 0) > 0 ||
      (t.deviceBrands?.length ?? 0) > 0;
    return hasRules ? false : 'no env targeting rules';
  }
  check(ctx: CheckContext): boolean {
    const t = ctx.promo.targeting;
    const e = ctx.env;
    if (t.os?.length && (!e?.os || !t.os.includes(e.os))) return false;
    if (t.environments?.length && (!e?.runtime || !t.environments.includes(e.runtime))) return false;
    if (t.deviceBrands?.length && (!e?.brand || !t.deviceBrands.includes(e.brand))) return false;
    return true;
  }
}
