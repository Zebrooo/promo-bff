/** Public request/response types for the B2C batch auction endpoint (SP3 + SP5). */
import type { ModelResult, Advertisement } from '../select-promo/types';

export interface AuctionPositionParam {
  slot: string;
  weight: number;
  /** Size-format family (horizontal|block|vertical); only candidates whose
   *  bannerFormat matches may fill this position. Omitted = legacy any-format. */
  format?: string;
  /** Actual rendered slot size. Must be supplied as a width+height pair; the
   *  winning horizontal creative uses it to select one server-side image variant. */
  width?: number;
  height?: number;
}

export interface AuctionParams {
  /** The page's positions to fill, each with a rank weight (lower = best place). */
  slots: AuctionPositionParam[];
  /** Page key for targeting (e.g. "home", "catalog-transport"). */
  page?: string;
  /** Optional identity (reserved for future targeting/frequency). */
  userId?: string;
  authenticated?: boolean;
}

/** Batch result: position id -> winning Advertisement, or null when unfilled. */
export type AuctionBatchData = Record<string, Advertisement | null>;

export type AuctionResult =
  | { status: 'ok'; data: AuctionBatchData }
  | { status: 'error'; reason: string };

export interface FeedFillParams {
  /** Number of in-feed positions to fill (the cascade depth requested). */
  count: number;
  /** Page key for targeting (e.g. "catalog-transport"). */
  page?: string;
  /** Viewer identity — used for the frequency cap (reads the impression store). */
  userId?: string;
  authenticated?: boolean;
  /** Size-format the feed wants (block for the grid card, horizontal for the list strip). */
  format?: string;
  /** Drop a campaign once this viewer has seen it >= freqCap times. Omit = no cap. */
  freqCap?: number;
}

/** Ordered fill (repeats allowed): the sequence of creatives to drop into the feed. */
export type FeedFillData = Advertisement[];

export type FeedFillResult =
  | { status: 'ok'; data: FeedFillData }
  | { status: 'error'; reason: string };

export type { ModelResult };
