import type { Promo } from './types';
import {
  Checker,
  loadSuppliers,
  WEB_CHECKERS,
  type CheckContext,
  type Logger,
  type SupplierDeps,
  type SupplierId,
  type SuppliersData,
} from './checkers';

export { WEB_CHECKERS };
export type { SupplierDeps };

export interface SelectPromoContext {
  userId: string;
  authenticated: boolean;
  now: Date;
  section?: string;
  category?: string;
  /** Requesting device; gates promos by deviceTarget. Undefined = no device filter. */
  device?: 'desktop' | 'touch';
  /** Formats the requesting surface accepts; gates promos by format. Undefined/empty = no filter. */
  formats?: string[];
}

export interface SelectPromoOptions {
  /** Defaults to WEB_CHECKERS. */
  checkers?: Checker<SupplierId>[];
  /** Checker names to skip entirely (consumer skipCheckers + persist auto-skip). */
  skip?: string[];
  deps: SupplierDeps;
  logger?: Logger;
}

/**
 * Walks the queue in order and returns the first promo that passes every active
 * checker (AND). Loads the union of required suppliers once before the loop.
 * Throws only if a supplier load fails (caller maps that to an error envelope).
 */
export async function selectPromo(
  promos: Promo[],
  ctx: SelectPromoContext,
  opts: SelectPromoOptions,
): Promise<Promo | null> {
  const checkers = opts.checkers ?? WEB_CHECKERS;
  const skip = opts.skip ?? [];
  const active = checkers.filter((c) => !skip.includes(c.name));
  const data = await loadSuppliers(active, { userId: ctx.userId, authenticated: ctx.authenticated }, opts.deps);

  for (const promo of promos) {
    const ctxP: CheckContext = {
      promo,
      userId: ctx.userId,
      authenticated: ctx.authenticated,
      now: ctx.now,
      section: ctx.section,
      category: ctx.category,
      device: ctx.device,
      formats: ctx.formats,
    };
    let passed = true;
    for (const c of active) {
      // Cast off Partial is safe: `active` drives both loadSuppliers and this
      // loop, so every supplier any active checker declares is present in `data`,
      // and each checker reads only its own declared id.
      if (!(await c.run(ctxP, data as SuppliersData<SupplierId>, opts.logger))) {
        passed = false;
        break;
      }
    }
    if (passed) return promo;
  }
  return null;
}
