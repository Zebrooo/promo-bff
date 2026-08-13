import { describe, expect, it } from 'vitest';
import { SearchChecker } from './Search';
import { makeCheckContext, makePromo } from '../../../test-utils';

const checker = new SearchChecker();
const now = new Date('2026-08-12T12:00:00.000Z');
const row = (query: string, section = 'avto', createdAt = '2026-08-11T12:00:00.000Z') => ({
  query,
  section,
  createdAt,
});

function context(
  search: NonNullable<ReturnType<typeof makePromo>['targeting']['search']>,
  searchHistory = [row('Toyota Camry')],
) {
  return makeCheckContext({
    promo: makePromo({ targeting: { search } }),
    now,
    searchHistory,
  });
}

describe('SearchChecker', () => {
  it('skips when no usable terms or sections are configured', () => {
    expect(checker.shouldSkip(makeCheckContext())).toBe('no search targeting');
    expect(checker.shouldSkip(context({ terms: [], sections: [] }))).toBe('no search targeting');
  });

  it('fails closed when a real rule has no history', () => {
    expect(checker.check(context({ terms: ['toyota'] }, []))).toBe(false);
  });

  it('does not skip punctuation-only rules and fails them closed', () => {
    const termRule = context({ terms: ['--'] });
    expect(checker.shouldSkip(termRule)).toBe(false);
    expect(checker.check(termRule)).toBe(false);

    const sectionRule = context({ sections: ['-'] });
    expect(checker.shouldSkip(sectionRule)).toBe(false);
    expect(checker.check(sectionRule)).toBe(false);
  });

  it('fails closed when punctuation leaves a one-character normalized term', () => {
    const termRule = context({ terms: ['C++'] }, [row('язык c для начинающих')]);
    expect(checker.shouldSkip(termRule)).toBe(false);
    expect(checker.check(termRule)).toBe(false);
  });

  it('matches any normalized whole phrase and does not match inside a word', () => {
    expect(checker.check(context({ terms: ['НОВЫЙ Toyota Camry'], match: 'any' }, [
      row('Ищу: новый, TOYOTA   CAMRY!'),
    ]))).toBe(true);
    expect(checker.check(context({ terms: ['кот'] }, [row('Скотч для машины')]))).toBe(false);
  });

  it('treats ё and е as the same character', () => {
    expect(checker.check(context({ terms: ['трёхдверный'] }, [row('трехдверный внедорожник')]))).toBe(true);
  });

  it('requires every term for all, allowing matches across different queries', () => {
    const search = { terms: ['toyota', 'camry'], match: 'all' as const };
    expect(checker.check(context(search, [row('Toyota Corolla'), row('Camry 70')]))).toBe(true);
    expect(checker.check(context(search, [row('Toyota Corolla')]))).toBe(false);
  });

  it('matches a section exactly after normalization and filters term rows by it', () => {
    expect(checker.check(context({ sections: [' АВТО '] }, [row('любой запрос', 'авто')]))).toBe(true);
    expect(checker.check(context({ terms: ['toyota'], sections: ['avto'] }, [
      row('Toyota', 'realty'),
      row('Honda', 'avto'),
    ]))).toBe(false);
  });

  it('honours the configured lookback window', () => {
    const history = [
      row('Toyota', 'avto', '2026-08-02T11:59:59.000Z'),
      row('Honda', 'avto', '2026-08-11T12:00:00.000Z'),
    ];
    expect(checker.check(context({ terms: ['toyota'], lookbackDays: 10 }, history))).toBe(false);
    expect(checker.check(context({ terms: ['honda'], lookbackDays: 10 }, history))).toBe(true);
  });
});
