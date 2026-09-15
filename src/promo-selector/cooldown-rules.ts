import type { CooldownPromoRule, Promo } from './types';

export interface CooldownRules {
  /** Общая пауза формата, минут; 0 = нет. */
  selfMinutes: number;
  /** Направленные правила; [] = нет. */
  promos: CooldownPromoRule[];
}

type CooldownFields = Pick<Promo, 'id' | 'cooldownHours' | 'cooldownSelfMinutes' | 'cooldownPromos'>;

/**
 * Единственная точка чтения полей пауз — чекеры и любой другой код берут
 * правила отсюда, а не из полей напрямую.
 *
 * Новые поля имеют приоритет. Устаревшее `cooldownHours: N > 0` без них
 * читается как пауза формата N×60 минут ПЛЮС правило «не повторять себя»
 * N×60 минут: так сохраняются оба прежних смысла поля — «не спамить этим
 * форматом» и «не показывать это промо дважды подряд» (промо с лимитом 2–4
 * иначе могло бы показаться на двух загрузках подряд).
 */
export function resolveCooldownRules(promo: CooldownFields): CooldownRules {
  const hasSelf = promo.cooldownSelfMinutes !== undefined;
  const hasPromos = (promo.cooldownPromos?.length ?? 0) > 0;
  if (hasSelf || hasPromos) {
    return { selfMinutes: Math.max(0, promo.cooldownSelfMinutes ?? 0), promos: promo.cooldownPromos ?? [] };
  }
  const hours = promo.cooldownHours ?? 0;
  if (hours <= 0) return { selfMinutes: 0, promos: [] };
  const minutes = hours * 60;
  return { selfMinutes: minutes, promos: [{ promoId: promo.id, minutes }] };
}
