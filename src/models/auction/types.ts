/** Public request/response types for the B2C batch auction endpoint (SP3 + SP5). */
import type { ModelResult, Advertisement } from '../select-promo/types';

export interface AuctionPositionParam {
  slot: string;
  weight: number;
  /** Size-format family (horizontal|block|vertical); only candidates whose
   *  bannerFormat matches may fill this position. Omitted = legacy any-format. */
  format?: string;
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

export type { ModelResult };
