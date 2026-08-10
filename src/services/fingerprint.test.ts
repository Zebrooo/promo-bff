import { describe, expect, it } from 'vitest';
import { fingerprint, normalizeErrorMetadata } from './fingerprint';

const DYNAMIC_ROUTE_CASES = [
  ['abkhaz-auto', '/[...catchAll]'],
  ['abkhaz-auto', '/[slug]'],
  ['abkhaz-auto', '/ad/[slug]'],
  ['abkhaz-auto', '/ad/[slug]/edit'],
  ['abkhaz-auto', '/admin/ads/[id]'],
  ['abkhaz-auto', '/admin/chats/[id]'],
  ['abkhaz-auto', '/admin/news/[id]'],
  ['abkhaz-auto', '/admin/news/[id]/edit'],
  ['abkhaz-auto', '/admin/support/[id]'],
  ['abkhaz-auto', '/api/cars/[brand]/models'],
  ['abkhaz-auto', '/api/chat/[id]/message'],
  ['abkhaz-auto', '/api/chat/[id]/message/[messageId]'],
  ['abkhaz-auto', '/api/chat/[id]/message/[messageId]/reaction'],
  ['abkhaz-auto', '/api/chat/[id]/read'],
  ['abkhaz-auto', '/api/chat/[id]/upload'],
  ['abkhaz-auto', '/api/chat/[id]/video-note'],
  ['abkhaz-auto', '/api/chat/[id]/voice'],
  ['abkhaz-auto', '/api/chat/media/[...path]'],
  ['abkhaz-auto', '/api/deals/[id]/transition'],
  ['abkhaz-auto', '/api/goods/[slug]'],
  ['abkhaz-auto', '/api/listing/[id]/show-phone'],
  ['abkhaz-auto', '/api/listing/[id]/view'],
  ['abkhaz-auto', '/api/listing/[id]/viewer'],
  ['abkhaz-auto', '/api/reviews/[id]'],
  ['abkhaz-auto', '/api/seller/[token]/listings'],
  ['abkhaz-auto', '/api/stickers/[id]'],
  ['abkhaz-auto', '/api/v1/brands/[slug]/models'],
  ['abkhaz-auto', '/api/v1/favorites/[listingId]'],
  ['abkhaz-auto', '/api/v1/listings/[slug]'],
  ['abkhaz-auto', '/api/v1/listings/by-id/[id]'],
  ['abkhaz-auto', '/api/v1/listings/by-id/[id]/photos'],
  ['abkhaz-auto', '/api/v1/listings/by-id/[id]/status'],
  ['abkhaz-auto', '/api/v1/news/[slug]'],
  ['abkhaz-auto', '/api/v1/photos/[id]'],
  ['abkhaz-auto', '/bb/[id]'],
  ['abkhaz-auto', '/category/[...parts]'],
  ['abkhaz-auto', '/i/[token]'],
  ['abkhaz-auto', '/ii/[...parts]'],
  ['abkhaz-auto', '/legacy-photo/[postId]/[filename]'],
  ['abkhaz-auto', '/lk/chat/[id]'],
  ['abkhaz-auto', '/lk/chat/[id]/media'],
  ['abkhaz-auto', '/lk/prodvizhenie/banner/[id]'],
  ['abkhaz-auto', '/nedvizhimost/[deal]'],
  ['abkhaz-auto', '/novosti/[slug]'],
  ['abkhaz-auto', '/prodavec/[key]'],
  ['abkhaz-auto', '/transport/[slug]'],
  ['abkhaz-auto', '/transport/shiny/[season]'],
  ['abkhaz-auto', '/u/[username]'],
  ['promo-cabinet', '/api/img/[...path]'],
  ['promo-cabinet', '/api/promos/[id]'],
  ['promo-cabinet', '/api/queues/[name]'],
  ['promo-cabinet', '/api/queues/[name]/[id]'],
  ['promo-cabinet', '/cabinet/[id]'],
  ['promo-cabinet', '/cabinet/queues/[name]'],
] as const;

function routeFromTemplate(template: string, value: string): string {
  return template
    .replace(/\[\.\.\.[^\]]+\]/g, `${value}/tail-${value}`)
    .replace(/\[[^\]]+\]/g, value);
}

describe('fingerprint', () => {
  it('normalizes HTTP and error metadata through one canonical boundary', () => {
    expect(normalizeErrorMetadata({ method: ' post ', statusCode: 201, kind: ' fetch ' })).toEqual({
      method: 'POST',
      statusCode: 201,
      kind: 'fetch',
    });
    expect(normalizeErrorMetadata({ method: 'RANDOM', statusCode: 700, kind: 'alice@example.com' })).toEqual({
      method: null,
      statusCode: null,
      kind: 'other',
    });
    expect(normalizeErrorMetadata({ method: 'GET\r\nX-Injected: yes' }).method).toBeNull();
    expect(normalizeErrorMetadata({
      method: { injected: 'POST' },
      statusCode: '500',
      kind: { email: 'alice@example.com' },
    })).toEqual({
      method: null,
      statusCode: null,
      kind: null,
    });
  });

  it('is stable for the same logical error', () => {
    const a = fingerprint('Cannot read x', 'Error\n    at f (/app/a.js:10:5)', 'TypeError');
    const b = fingerprint('Cannot read x', 'Error\n    at f (/app/a.js:10:5)', 'TypeError');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('ignores volatile numbers/ids/urls in the message', () => {
    const a = fingerprint('User 12345 not found at https://x/y?q=1', null, 'Error');
    const b = fingerprint('User 99 not found at https://z/w?q=2', null, 'Error');
    expect(a).toBe(b);
  });

  it('groups the same endpoint across ids, queries, hashes, and method casing', () => {
    const a = fingerprint('request failed', null, 'Error', {
      route: 'https://api.example.com/api/orders/123/items/550e8400-e29b-41d4-a716-446655440000?token=secret#private',
      method: ' get ',
      statusCode: 500,
      kind: 'fetch',
    });
    const b = fingerprint('request failed', null, 'Error', {
      route: '/api/orders/987/items/6ba7b810-9dad-11d1-80b4-00c04fd430c8?user=other#different',
      method: 'GET',
      statusCode: 500,
      kind: 'fetch',
    });
    expect(a).toBe(b);
  });

  it('redacts email-like route segments while preserving the endpoint structure', () => {
    const a = fingerprint('request failed', null, 'Error', {
      route: '/api/users/alice%40example.com/preferences?token=secret',
    });
    const b = fingerprint('request failed', null, 'Error', {
      route: '/api/users/bob%40example.net/preferences#profile',
    });
    expect(a).toBe(b);
  });

  it('groups user profile routes across usernames without retaining query or hash data', () => {
    const a = fingerprint('request failed', null, 'Error', {
      route: '/u/alice?email=alice@example.com#private',
    });
    const b = fingerprint('request failed', null, 'Error', {
      route: '/u/bob?email=bob@example.net#different',
    });
    expect(a).toBe(b);
  });

  it.each(DYNAMIC_ROUTE_CASES)('groups trusted %s route template %s', (service, template) => {
    const a = fingerprint('request failed', null, 'Error', {
      route: routeFromTemplate(template, 'alice-private'),
      service,
    });
    const b = fingerprint('request failed', null, 'Error', {
      route: routeFromTemplate(template, 'bob-private'),
      service,
    });
    expect(a).toBe(b);
  });

  it('keeps static children of dynamic route families distinct', () => {
    const abkhaz = { service: 'abkhaz-auto' };
    const cabinet = { service: 'promo-cabinet' };
    const inbox = fingerprint('request failed', null, 'Error', { ...abkhaz, route: '/api/chat/inbox' });
    const start = fingerprint('request failed', null, 'Error', { ...abkhaz, route: '/api/chat/start' });
    const create = fingerprint('request failed', null, 'Error', { ...abkhaz, route: '/api/v1/listings/create' });
    expect(inbox).not.toBe(start);
    expect(create).not.toBe(fingerprint('request failed', null, 'Error', {
      ...abkhaz,
      route: '/api/v1/listings/private-slug',
    }));
    expect(fingerprint('request failed', null, 'Error', { ...abkhaz, route: '/novosti/rss.xml' })).not.toBe(
      fingerprint('request failed', null, 'Error', { ...abkhaz, route: '/novosti/private-slug' }),
    );
    expect(fingerprint('request failed', null, 'Error', { ...cabinet, route: '/cabinet/new' })).not.toBe(
      fingerprint('request failed', null, 'Error', { ...cabinet, route: '/cabinet/private-id' }),
    );
    expect(fingerprint('request failed', null, 'Error', { ...cabinet, route: '/cabinet/queues' })).not.toBe(
      fingerprint('request failed', null, 'Error', { ...cabinet, route: '/cabinet/queues/private-name' }),
    );
  });

  it('fails safe for unknown static endpoint families', () => {
    const context = { service: 'abkhaz-auto' };
    const foo = fingerprint('request failed', null, 'Error', { ...context, route: '/api/foo' });
    const bar = fingerprint('request failed', null, 'Error', { ...context, route: '/api/bar' });
    expect(foo).not.toBe(bar);
  });

  it.each([
    ['route', { route: '/api/bar/123' }],
    ['status', { statusCode: 404 }],
    ['method', { method: 'POST' }],
    ['kind', { kind: 'resource' }],
  ])('separates matching errors with a different %s', (_field, override) => {
    const base = { route: '/api/foo/123', method: 'GET', statusCode: 500, kind: 'fetch' };
    const a = fingerprint('request failed', null, 'Error', base);
    const b = fingerprint('request failed', null, 'Error', { ...base, ...override });
    expect(a).not.toBe(b);
  });

  it('keeps URL redaction in messages when request context is present', () => {
    const context = { route: '/api/foo/123', method: 'GET', statusCode: 500, kind: 'fetch' };
    const a = fingerprint('failed at https://one.example/api/users/123?token=secret', null, 'Error', context);
    const b = fingerprint('failed at https://two.example/private/bob?email=bob@example.com', null, 'Error', context);
    expect(a).toBe(b);
  });

  it('groups fetch endpoint ids and queries while separating static endpoints on the same page', () => {
    const page = { route: '/u/alice', kind: 'fetch' };
    const firstItem = fingerprint('request failed', null, 'Error', {
      ...page,
      endpoint: 'https://api.example.com/api/items/123?user=alice#private',
    });
    const secondItem = fingerprint('request failed', null, 'Error', {
      ...page,
      endpoint: '/api/items/456?user=bob#different',
    });
    expect(firstItem).toBe(secondItem);

    const apiA = fingerprint('request failed', null, 'Error', { ...page, endpoint: '/api/a?user=alice' });
    const apiB = fingerprint('request failed', null, 'Error', { ...page, endpoint: '/api/b#private' });
    expect(apiA).not.toBe(apiB);
  });

  it('keeps only the error kinds used by abkhaz web and buckets unknown strings', () => {
    const allowedKinds = [
      'window.onerror',
      'unhandledrejection',
      'resource',
      'console.error',
      'fetch',
      'auth',
      'error-boundary',
      'global-error',
      'other',
    ];
    const keys = allowedKinds.map((kind) => fingerprint('request failed', null, 'Error', { kind }));
    expect(new Set(keys).size).toBe(allowedKinds.length);

    const withoutKind = fingerprint('request failed', null, 'Error', {});
    const nonStringKind = fingerprint('request failed', null, 'Error', { kind: { source: 'server' } });
    expect(nonStringKind).toBe(withoutKind);

    const other = fingerprint('request failed', null, 'Error', { kind: 'other' });
    expect(fingerprint('request failed', null, 'Error', { kind: 'alice@example.com' })).toBe(other);
    expect(fingerprint('request failed', null, 'Error', { kind: 'private-user-specific-kind' })).toBe(other);
    expect(fingerprint('request failed', null, 'Error', { kind: 'a'.repeat(128) })).toBe(other);
  });

  it('ignores non-standard methods and invalid HTTP status codes', () => {
    const withoutHttp = fingerprint('request failed', null, 'Error', {});
    expect(fingerprint('request failed', null, 'Error', { method: 'RANDOM' })).toBe(withoutHttp);
    expect(fingerprint('request failed', null, 'Error', { method: 'GET\r\nX-Injected: yes' })).toBe(withoutHttp);
    expect(fingerprint('request failed', null, 'Error', {
      method: { injected: 'POST' } as unknown as string,
    })).toBe(withoutHttp);
    expect(fingerprint('request failed', null, 'Error', { statusCode: -1 })).toBe(withoutHttp);
    expect(fingerprint('request failed', null, 'Error', { statusCode: 700 })).toBe(withoutHttp);
    expect(fingerprint('request failed', null, 'Error', { statusCode: 500.5 })).toBe(withoutHttp);

    const methods = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH'];
    const methodKeys = methods.map((method) => fingerprint('request failed', null, 'Error', { method }));
    expect(new Set(methodKeys).size).toBe(methods.length);

    const status100 = fingerprint('request failed', null, 'Error', { statusCode: 100 });
    const status599 = fingerprint('request failed', null, 'Error', { statusCode: 599 });
    expect(status100).not.toBe(withoutHttp);
    expect(status599).not.toBe(withoutHttp);
    expect(status100).not.toBe(status599);
  });

  it('ignores line:col differences in the stack', () => {
    const a = fingerprint('boom', 'Error\n    at f (/app/a.js:10:5)', 'Error');
    const b = fingerprint('boom', 'Error\n    at f (/app/a.js:42:99)', 'Error');
    expect(a).toBe(b);
  });

  it('separates genuinely different errors', () => {
    const a = fingerprint('database down', null, 'Error');
    const b = fingerprint('payment declined', null, 'Error');
    expect(a).not.toBe(b);
  });
});
