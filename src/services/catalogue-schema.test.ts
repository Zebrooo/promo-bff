import { describe, expect, it } from 'vitest';
import { catalogueSchema, promoSchema, queueSchema } from './catalogue-schema';
import { makePromo } from '../test-utils';

describe('promoSchema', () => {
  it('accepts a fully-valid promo', () => {
    expect(() => promoSchema.parse(makePromo())).not.toThrow();
  });

  it('rejects a negative cooldownHours', () => {
    expect(() => promoSchema.parse(makePromo({ cooldownHours: -1 }))).toThrow();
  });

  it('accepts an audience target', () => {
    expect(() => promoSchema.parse(makePromo({ audience: 'authenticated' }))).not.toThrow();
    expect(() => promoSchema.parse(makePromo({ audience: 'nope' as never }))).toThrow();
  });

  it('rejects a non-ISO startsAt', () => {
    expect(() => promoSchema.parse(makePromo({ startsAt: 'yesterday' }))).toThrow();
  });

  it('rejects an unknown format', () => {
    expect(() => promoSchema.parse(makePromo({ format: 'banner' as never }))).toThrow();
  });

  it('accepts the topline format', () => {
    expect(() => promoSchema.parse(makePromo({ format: 'topline' }))).not.toThrow();
  });

  it('rejects a promo missing required fields', () => {
    expect(() => promoSchema.parse({ id: 'x' })).toThrow();
  });

  it('accepts sections and categories arrays', () => {
    const parsed = promoSchema.parse(makePromo({ sections: ['avto'], categories: ['kvartiry'] }));
    expect(parsed.sections).toEqual(['avto']);
    expect(parsed.categories).toEqual(['kvartiry']);
  });

  it('rejects a non-string section', () => {
    expect(() => promoSchema.parse(makePromo({ sections: [1] as never }))).toThrow();
  });
});

describe('catalogueSchema', () => {
  it('accepts an ordered array of promos and preserves order', () => {
    const parsed = catalogueSchema.parse([makePromo({ id: 'a' }), makePromo({ id: 'b' })]);
    expect(parsed.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('rejects a non-array', () => {
    expect(() => catalogueSchema.parse({ id: 'a' })).toThrow();
  });
});

describe('queueSchema', () => {
  it('queueSchema accepts an array of id strings', () => {
    expect(() => queueSchema.parse(['a', 'b'])).not.toThrow();
    expect(() => queueSchema.parse([1, 2])).toThrow();
  });
});
