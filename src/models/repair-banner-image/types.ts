/** Типы для POST /repair-banner-image — модератор витрины чинит баннер
 *  рекламодателя под рекламные места. Envelope тот же, что у
 *  /enhance-banner-image: сайт разбирает их одним кодом. */
import type { BannerImageDraft, EnhanceBannerImageData } from '../enhance-banner-image/types';

/** careful — правим присланный баннер по минимуму (умолчание в интерфейсе);
 *  rebuild — собираем новый, как /enhance-banner-image, плюс указания модератора. */
export const REPAIR_MODES = ['careful', 'rebuild'] as const;
export type RepairMode = (typeof REPAIR_MODES)[number];

/** Порядок здесь — порядок строк в промпте, от запроса он не зависит. */
export const REPAIR_FIXES = [
  'fit_safe_area',
  'free_overlay_zone',
  'restore_text',
  'contrast',
  'drop_small_text',
  'clean_background',
] as const;
export type RepairFix = (typeof REPAIR_FIXES)[number];

/** Прямоугольник в долях готового файла W×H (0..1), от левого верхнего угла.
 *  В доли кадра модели его переводит prompt.ts. */
export interface BannerZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface RepairBannerImageParams {
  /** Ключ лимита и учёта расходов. Сайт шлёт «mod:<adminUserId>», чтобы у
   *  модераторов был свой бюджет, а не бюджет рекламодателя. */
  advertiserId: string;
  /** Баннер рекламодателя — http(s) или data:image/…, как у enhance. */
  imageUrl: string;
  /** Точный размер готового файла (600×750, 600×1000, 2400×300, 1160×240…). */
  width: number;
  height: number;
  mode: RepairMode;
  /** Выбранные модератором правки, без повторов. */
  fixes: RepairFix[];
  /** Указания модератора по-русски, уже очищенные (см. validate.ts). */
  notes?: string;
  /** Область, видимая во всех размещениях: весь текст и важное — внутри. */
  safeArea?: BannerZone;
  /** Сюда витрина кладёт свою подпись — здесь не должно быть текста и важного. */
  reservedZone?: BannerZone;
  /** rebuild: заголовок/описание для новой картинки. careful его в промпт не
   *  берёт (см. prompt.ts), без черновика в запросе здесь {}. */
  draft: BannerImageDraft;
  /** Угол раскладки для rebuild — как у enhance. */
  ctaPosition?: string;
  /** Номер варианта 0…20: «ещё вариант» в модерации шлёт тот же запрос с
   *  другим номером. Только в ключе кэша — иначе повтор вернул бы ту же
   *  картинку из кэша; в промпт не идёт. */
  variant?: number;
}

export type RepairBannerImageData = EnhanceBannerImageData;

export type RepairBannerImageResult =
  | { status: 'ok'; data: RepairBannerImageData }
  | { status: 'error'; reason: string };
