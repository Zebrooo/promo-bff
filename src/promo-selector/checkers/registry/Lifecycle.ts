import { Checker, type CheckContext, type SuppliersData } from '../Checker';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Гейт по стадии жизненного цикла СОБСТВЕННЫХ объявлений зрителя
 * (promo.lifecycle, спека targeting-lifecycle). Все заданные условия
 * объединяются по И; каждое условие при undefined-данных возвращает false
 * (fail closed: «сигнала нет → промо пропускается»). Анонимы не проходят
 * никогда: и явным isAuthorized-гейтом, и по данным — их supplier не ходит
 * в БД и lifecycle-полей не отдаёт.
 *
 * Поля lastSoldAt/hasStalledActive/totalListings/firstCreatedAt приезжают из
 * RPC promo_listing_stats; пока миграция не применена, listing-service
 * оставляет их undefined (fail-soft) — фейлятся только lifecycle-промо.
 */
export class LifecycleChecker extends Checker<'listingStats'> {
  readonly name = 'lifecycle';
  readonly requiredSupplierIDs = ['listingStats'] as const;

  expect() {
    return 'user matches every promo.lifecycle own-listings condition (AND)';
  }

  shouldSkip(ctx: CheckContext): false | string {
    return ctx.promo.lifecycle === undefined ? 'no lifecycle gate' : false;
  }

  check(ctx: CheckContext, data: SuppliersData<'listingStats'>): boolean {
    const gate = ctx.promo.lifecycle;
    if (gate === undefined) return true; // недостижимо после shouldSkip; страховка
    // Гость по определению не имеет собственных объявлений — мимо всегда.
    if (!ctx.isAuthorized) return false;
    // Hand-built promos can bypass Zod. Пустой гейт {} — невалидное правило:
    // вакуумное «все условия выполнены» показало бы промо всем (принцип
    // SearchChecker: invalid configured rule = fail, not pass).
    if (
      gate.activeInCategories === undefined &&
      gate.soldWithinDays === undefined &&
      gate.hasStalledActive === undefined &&
      gate.firstListingWithinDays === undefined
    ) {
      return false;
    }
    const stats = data.listingStats;
    const nowMs = ctx.now.getTime();

    if (gate.activeInCategories !== undefined) {
      const wanted = gate.activeInCategories.filter((slug) => slug.trim() !== '');
      // Рукописный пустой список / пустые строки — невалидное правило.
      if (wanted.length === 0 || wanted.length !== gate.activeInCategories.length) return false;
      const own = stats.activeCategories;
      if (!own || !wanted.some((slug) => own.includes(slug))) return false;
    }
    if (gate.soldWithinDays !== undefined) {
      if (!Number.isInteger(gate.soldWithinDays) || gate.soldWithinDays < 1) return false;
      const soldMs = stats.lastSoldAt ? Date.parse(stats.lastSoldAt) : NaN;
      if (!Number.isFinite(soldMs) || nowMs - soldMs > gate.soldWithinDays * DAY_MS) return false;
    }
    if (gate.hasStalledActive !== undefined && stats.hasStalledActive !== true) return false;
    if (gate.firstListingWithinDays !== undefined) {
      if (!Number.isInteger(gate.firstListingWithinDays) || gate.firstListingWithinDays < 1) return false;
      if (stats.totalListings !== 1) return false;
      const createdMs = stats.firstCreatedAt ? Date.parse(stats.firstCreatedAt) : NaN;
      if (!Number.isFinite(createdMs) || nowMs - createdMs > gate.firstListingWithinDays * DAY_MS) return false;
    }
    return true;
  }
}
