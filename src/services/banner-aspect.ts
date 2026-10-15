/**
 * Соотношение сторон для модели картинок. Nano Banana 2 принимает
 * `image_config.aspect_ratio` только из фиксированного набора — в нём есть и
 * полосы 8:1 / 4:1, под которые рекламодатель грузит баннеры. Без этого
 * параметра модель рисует «как получится» (на тест-стенде: 1,2:1 и 0,6:1 для
 * полосы 8:1), а дальше cover-кроп транскода выбрасывал бо́льшую часть кадра
 * вместе с впечатанным заголовком.
 */
export const IMAGE_ASPECT_RATIOS = [
  '1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9', '1:4', '4:1', '1:8', '8:1',
] as const;

export type ImageAspectRatio = (typeof IMAGE_ASPECT_RATIOS)[number];

function ratioValue(ratio: ImageAspectRatio): number {
  const [w, h] = ratio.split(':').map(Number);
  return w / h;
}

/** Ближайшее поддерживаемое соотношение — по расстоянию в логарифме, чтобы
 *  «в полтора раза шире» и «в полтора раза уже» считались одинаково далёкими. */
export function pickAspectRatio(width: number, height: number): ImageAspectRatio {
  const target = Math.log(width / height);
  let best: ImageAspectRatio = '1:1';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ratio of IMAGE_ASPECT_RATIOS) {
    const distance = Math.abs(Math.log(ratioValue(ratio)) - target);
    if (distance < bestDistance) {
      best = ratio;
      bestDistance = distance;
    }
  }
  return best;
}

/** Форма баннера для промпта: от неё зависит раскладка (полоса читается слева
 *  направо, постер — сверху вниз). Порог полосы 2,5 — тот же, что у витрины
 *  (`short` в AdSlot: на такой полосе заголовок-оверлей не рисуется). */
export type BannerShape = 'strip' | 'landscape' | 'square' | 'portrait';

export function bannerShape(width: number, height: number): BannerShape {
  const ratio = width / height;
  if (ratio >= 2.5) return 'strip';
  if (ratio > 1.2) return 'landscape';
  if (ratio >= 1 / 1.2) return 'square';
  return 'portrait';
}
