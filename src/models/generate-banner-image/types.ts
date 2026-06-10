/** Types for POST /generate-banner-image — text-to-image generation для промо.
 *  Используется когда юзер не загрузил референс — генерим из чистого промпта.
 *  Внутри handler передаём 1×1 white placeholder как imageUrl (Nano Banana
 *  требует поле), модель полностью полагается на текстовый промпт. */
import type { ModelResult } from '../select-promo/types';

export interface GenerateBannerImageParams {
  /** Rate-limit + cost-log attribution key (cabinet sends admin user или promo.id). */
  advertiserId: string;
  /** Free-form Russian/English text describing what the banner should show.
   *  e.g. «летний попап для гостиницы в Гагре, тёплые цвета моря, абхазский колорит» */
  prompt: string;
  /** Target dimensions of the output banner. Capped at 4096 per side. */
  width: number;
  height: number;
}

export interface GenerateBannerImageData {
  /** Generated image as base64 data URL — cabinet decodes и кладёт в S3. */
  imageDataUrl: string;
  cacheHit: boolean;
  model: string;
}

export type GenerateBannerImageResult =
  | { status: 'ok'; data: GenerateBannerImageData }
  | { status: 'error'; reason: string };

export type { ModelResult };
