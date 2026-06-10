import type { SelectPromoDeps } from './select-promo/handle';
import { handleSelectPromo } from './select-promo/handle';
import { validateParams } from './select-promo/validate';
import type { ModelResult, SelectPromoParams } from './select-promo/types';

export interface ModelDefinition<Params> {
  validate(params: unknown): { ok: true; params: Params } | { ok: false; error: string };
  handle(params: Params, deps: SelectPromoDeps): Promise<ModelResult>;
}

/**
 * Model registry. One model today (select-promo). To add another: write its
 * validate + handle and add an entry here — nothing else in the server changes.
 * Deliberately a plain object, not an abstraction layer.
 */
export const modelRegistry = {
  'select-promo': {
    validate: validateParams,
    handle: handleSelectPromo,
  } satisfies ModelDefinition<SelectPromoParams>,
} as const;

export type ModelName = keyof typeof modelRegistry;

export function isModelName(name: string): name is ModelName {
  return Object.prototype.hasOwnProperty.call(modelRegistry, name);
}
