import { Checker, type CheckContext, type SearchHistoryEntry } from '../Checker';
import type { Promo } from '../../types';
import { isValidNormalizedSearchTerm, normalizeSearchValue } from '../../../util/search-normalization';

export { normalizeSearchValue } from '../../../util/search-normalization';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 30;

function configuredValues(values: string[] | undefined): string[] {
  return (values ?? []).filter((value) => value.trim() !== '');
}

/** A non-empty configured value is a rule even if normalization later rejects it. */
export function hasSearchRule(promo: Promo): boolean {
  const search = promo.targeting.search;
  return configuredValues(search?.terms).length > 0 || configuredValues(search?.sections).length > 0;
}

function phraseMatches(query: string, term: string): boolean {
  return query === term || query.startsWith(`${term} `) || query.endsWith(` ${term}`) || query.includes(` ${term} `);
}

function rowsInWindow(ctx: CheckContext, allowedSections: string[]): SearchHistoryEntry[] {
  const search = ctx.promo.targeting.search;
  const lookbackDays = search?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const nowMs = ctx.now.getTime();
  const cutoffMs = nowMs - lookbackDays * DAY_MS;
  return (ctx.searchHistory ?? []).filter((row) => {
    const createdMs = Date.parse(row.createdAt);
    if (!Number.isFinite(createdMs) || createdMs < cutoffMs || createdMs > nowMs) return false;
    if (allowedSections.length === 0) return true;
    return allowedSections.includes(normalizeSearchValue(row.section));
  });
}

/** Gates promos by the request viewer's already-recorded search history. */
export class SearchChecker extends Checker {
  readonly name = 'search';

  expect() {
    return 'search history matches the promo search targeting';
  }

  shouldSkip(ctx: CheckContext): false | string {
    return hasSearchRule(ctx.promo) ? false : 'no search targeting';
  }

  check(ctx: CheckContext): boolean {
    const search = ctx.promo.targeting.search;
    const rawTerms = configuredValues(search?.terms);
    const rawSections = configuredValues(search?.sections);
    const terms = rawTerms.map(normalizeSearchValue);
    const sections = rawSections.map(normalizeSearchValue);
    // Hand-built promos can bypass Zod. Never turn an invalid configured rule
    // into a skip/pass just because punctuation normalization erased it.
    if (rawTerms.some((term) => !isValidNormalizedSearchTerm(term)) || sections.some((section) => section === '')) {
      return false;
    }

    const rows = rowsInWindow(ctx, sections);
    if (rows.length === 0) return false;

    if (terms.length === 0) return true;

    const queries = rows.map((row) => normalizeSearchValue(row.query)).filter(Boolean);
    const matched = (term: string) => queries.some((query) => phraseMatches(query, term));
    return search?.match === 'all' ? terms.every(matched) : terms.some(matched);
  }
}
