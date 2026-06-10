/** Types for POST /enhance-banner-image — image regeneration via "Nano Banana 2".
 *  Same envelope shape as the other models (status/data|reason) so the cabinet
 *  treats it uniformly. */
import type { ModelResult } from '../select-promo/types';

export interface BannerImageDraft {
  /** Text the model should render onto the banner — typically the AI-improved
   *  title. The model bakes this onto the image. */
  title?: string;
  /** Optional secondary line (e.g. shorter slogan or just background context). */
  description?: string;
  /** Text for the CTA pill / button drawn onto the image. */
  actionLabel?: string;
}

export interface EnhanceBannerImageParams {
  /** Rate-limit + cost-log attribution key (cabinet sends the user UUID). */
  advertiserId: string;
  /** Public URL of the user's uploaded image (used as visual reference). */
  imageUrl: string;
  /** Target dimensions of the slot the banner lives in (e.g. 970×120). The
   *  model is told to render at this aspect ratio. */
  width: number;
  height: number;
  /** The texts to bake onto the image. Caller passes whatever they want
   *  rendered (usually the AI-improved suggestions). */
  draft: BannerImageDraft;
  /** Where the CSS CTA pill will be overlaid on top of the image — the
   *  model is asked to leave that corner free and position the title away
   *  from it. One of "tl"|"tr"|"bl"|"br"; defaults to "br" inside the handle. */
  ctaPosition?: string;
}

export interface EnhanceBannerImageData {
  /** Generated image as a base64 data URL — the cabinet uploads it to Storage
   *  before exposing it as an https://... URL to the browser. */
  imageDataUrl: string;
  cacheHit: boolean;
  model: string;
}

export type EnhanceBannerImageResult =
  | { status: 'ok'; data: EnhanceBannerImageData }
  | { status: 'error'; reason: string };

export type { ModelResult };
