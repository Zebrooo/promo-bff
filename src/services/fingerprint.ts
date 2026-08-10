import { createHash } from 'node:crypto';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ROUTE_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ROUTE_NUMERIC_ID = /(^|[-_.])\d+(?=$|[-_.])/g;
const EMAIL = /^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/;
const PHONE = /^\+?\d[\d(). -]{6,}\d$/;
const MAX_ROUTE_LENGTH = 512;
const MAX_KIND_LENGTH = 64;
const HTTP_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'CONNECT', 'OPTIONS', 'TRACE', 'PATCH']);
const ERROR_KINDS = new Set([
  'window.onerror',
  'unhandledrejection',
  'resource',
  'console.error',
  'fetch',
  'auth',
  'error-boundary',
  'global-error',
  'other',
]);

// Source-owned snapshots from abkhaz-auto-web and promo-cabinet src/app entrypoints.
// Never trust a client-provided template; unknown routes fall back to segment sanitizing
// so a stale registry cannot merge unrelated static endpoint families.
const ABKHAZ_ROUTE_TEMPLATES = [
  '/[...catchAll]',
  '/[slug]',
  '/ad/[slug]',
  '/ad/[slug]/edit',
  '/admin/ads/[id]',
  '/admin/chats/[id]',
  '/admin/news/[id]',
  '/admin/news/[id]/edit',
  '/admin/support/[id]',
  '/api/cars/[brand]/models',
  '/api/chat/[id]/message',
  '/api/chat/[id]/message/[messageId]',
  '/api/chat/[id]/message/[messageId]/reaction',
  '/api/chat/[id]/read',
  '/api/chat/[id]/upload',
  '/api/chat/[id]/video-note',
  '/api/chat/[id]/voice',
  '/api/chat/media/[...path]',
  '/api/deals/[id]/transition',
  '/api/goods/[slug]',
  '/api/listing/[id]/show-phone',
  '/api/listing/[id]/view',
  '/api/listing/[id]/viewer',
  '/api/reviews/[id]',
  '/api/seller/[token]/listings',
  '/api/stickers/[id]',
  '/api/v1/brands/[slug]/models',
  '/api/v1/favorites/[listingId]',
  '/api/v1/listings/[slug]',
  '/api/v1/listings/by-id/[id]',
  '/api/v1/listings/by-id/[id]/photos',
  '/api/v1/listings/by-id/[id]/status',
  '/api/v1/news/[slug]',
  '/api/v1/photos/[id]',
  '/bb/[id]',
  '/category/[...parts]',
  '/i/[token]',
  '/ii/[...parts]',
  '/legacy-photo/[postId]/[filename]',
  '/lk/chat/[id]',
  '/lk/chat/[id]/media',
  '/lk/prodvizhenie/banner/[id]',
  '/nedvizhimost/[deal]',
  '/novosti/[slug]',
  '/prodavec/[key]',
  '/transport/[slug]',
  '/transport/shiny/[season]',
  '/u/[username]',
] as const;

const PROMO_CABINET_ROUTE_TEMPLATES = [
  '/api/img/[...path]',
  '/api/promos/[id]',
  '/api/queues/[name]',
  '/api/queues/[name]/[id]',
  '/cabinet/[id]',
  '/cabinet/queues/[name]',
] as const;

const ABKHAZ_STATIC_ROUTE_FAMILIES = new Set([
  'admin',
  'api',
  'auth-retry',
  'baraholka',
  'bezopasnost',
  'kontakty',
  'legacy-app-gate',
  'lk',
  'lk-welcome',
  'nedvizhimost',
  'novosti',
  'o-nas',
  'oferta',
  'podat',
  'podderzhka',
  'politika-konfidentsialnosti',
  'pravila',
  'rabota',
  'reklama',
  'search',
  'sitemap-index.xml',
  'tarify',
  'transport',
  'uslugi',
  'vhod',
]);

const STATIC_ROUTE_CONFLICTS: Readonly<Record<string, ReadonlySet<string>>> = {
  'abkhaz-auto': new Set([
    '/admin/news/new',
    '/admin/news/settings',
    '/admin/news/sources',
    '/api/stickers/report',
    '/api/stickers/upload',
    '/api/v1/listings/create',
    '/lk/chat/share',
    '/lk/chat/support',
    '/lk/prodvizhenie/banner/new',
    '/nedvizhimost/posutochno',
    '/nedvizhimost/snyat',
    '/novosti/rss.xml',
  ]),
  'promo-cabinet': new Set([
    '/cabinet/abkhaz-auto',
    '/cabinet/metrics',
    '/cabinet/new',
    '/cabinet/queue',
    '/cabinet/queues',
  ]),
};

const DYNAMIC_SEGMENT = /^\[[^\]]+\]$/;
const CATCH_ALL_SEGMENT = /^\[\.\.\.[^\]]+\]$/;
const OPTIONAL_CATCH_ALL_SEGMENT = /^\[\[\.\.\.[^\]]+\]\]$/;

interface CompiledRouteTemplate {
  segments: readonly string[];
  normalized: string;
  rootFallback: boolean;
  score: number;
}

export interface ErrorMetadataInput {
  method?: unknown;
  statusCode?: unknown;
  kind?: unknown;
}

export interface NormalizedErrorMetadata {
  method: string | null;
  statusCode: number | null;
  kind: string | null;
}

export interface FingerprintContext {
  service?: string | null;
  route?: string | null;
  endpoint?: string | null;
  method?: string | null;
  statusCode?: number | null;
  kind?: unknown;
}

function normalizeMessage(message: string): string {
  return (message ?? '')
    .toLowerCase()
    .replace(UUID, '*')
    .replace(/0x[0-9a-f]+/g, '*')
    .replace(/https?:\/\/[^\s)'"]+/g, '*')
    .replace(/["'`][^"'`]*["'`]/g, '*')
    .replace(/\d+/g, '*')
    .replace(/\s+/g, ' ')
    .trim();
}

function topFrames(stack: string | null | undefined, n = 3): string {
  if (!stack) return '';
  return stack
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('at '))
    .slice(0, n)
    .map((f) => f.replace(/:\d+:\d+/g, '').replace(/\?[^\s):]*/g, '').replace(/0x[0-9a-f]+/g, '*'))
    .join('|');
}

function decodeRouteSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function normalizeRouteSegment(segment: string): string {
  const decoded = decodeRouteSegment(segment);
  if (/^\d+$/.test(decoded) || EMAIL.test(decoded) || PHONE.test(decoded) || /^[0-9a-f]{16,}$/i.test(decoded)) {
    return '*';
  }
  return encodeURIComponent(decoded.replace(ROUTE_UUID, '*').replace(ROUTE_NUMERIC_ID, '$1*'));
}

function compileRouteTemplate(template: string): CompiledRouteTemplate {
  const segments = template.split('/').filter(Boolean);
  const normalizedSegments = segments.map((segment) => {
    if (CATCH_ALL_SEGMENT.test(segment) || OPTIONAL_CATCH_ALL_SEGMENT.test(segment)) return '**';
    return DYNAMIC_SEGMENT.test(segment) ? '*' : segment;
  });
  const score = segments.reduce((total, segment) => {
    if (CATCH_ALL_SEGMENT.test(segment) || OPTIONAL_CATCH_ALL_SEGMENT.test(segment)) return total + 1;
    return total + (DYNAMIC_SEGMENT.test(segment) ? 10 : 100);
  }, 0);
  return {
    segments,
    normalized: `/${normalizedSegments.join('/')}`,
    rootFallback: template === '/[slug]' || template === '/[...catchAll]',
    score,
  };
}

function compileRouteTemplates(templates: readonly string[]): readonly CompiledRouteTemplate[] {
  return templates.map(compileRouteTemplate).sort((a, b) => b.score - a.score);
}

const COMPILED_ROUTE_TEMPLATES: Readonly<Record<string, readonly CompiledRouteTemplate[]>> = {
  'abkhaz-auto': compileRouteTemplates(ABKHAZ_ROUTE_TEMPLATES),
  'promo-cabinet': compileRouteTemplates(PROMO_CABINET_ROUTE_TEMPLATES),
};
const SHARED_ROUTE_TEMPLATES = compileRouteTemplates([
  ...ABKHAZ_ROUTE_TEMPLATES.filter((template) => template !== '/[slug]' && template !== '/[...catchAll]'),
  ...PROMO_CABINET_ROUTE_TEMPLATES,
]);
const SHARED_STATIC_ROUTE_CONFLICTS = new Set(
  Object.values(STATIC_ROUTE_CONFLICTS).flatMap((routes) => [...routes]),
);

function matchesRouteTemplate(pathSegments: readonly string[], template: CompiledRouteTemplate): boolean {
  let pathIndex = 0;
  for (let templateIndex = 0; templateIndex < template.segments.length; templateIndex += 1) {
    const expected = template.segments[templateIndex];
    const isLast = templateIndex === template.segments.length - 1;
    if (OPTIONAL_CATCH_ALL_SEGMENT.test(expected)) {
      return isLast && pathSegments.slice(pathIndex).every(Boolean);
    }
    if (CATCH_ALL_SEGMENT.test(expected)) {
      return isLast && pathIndex < pathSegments.length && pathSegments.slice(pathIndex).every(Boolean);
    }
    const actual = pathSegments[pathIndex];
    if (!actual) return false;
    if (!DYNAMIC_SEGMENT.test(expected) && actual !== expected) return false;
    pathIndex += 1;
  }
  return pathIndex === pathSegments.length;
}

function normalizeTrustedRoute(pathSegments: readonly string[], service: string | null | undefined): string {
  const normalizedService = typeof service === 'string' ? service.trim() : '';
  const staticRoutes = STATIC_ROUTE_CONFLICTS[normalizedService] ?? SHARED_STATIC_ROUTE_CONFLICTS;
  if (staticRoutes.has(`/${pathSegments.join('/')}`)) return '';

  const templates = COMPILED_ROUTE_TEMPLATES[normalizedService] ?? SHARED_ROUTE_TEMPLATES;
  for (const template of templates) {
    if (template.rootFallback) {
      if (normalizedService !== 'abkhaz-auto') continue;
      if (ABKHAZ_STATIC_ROUTE_FAMILIES.has(pathSegments[0] ?? '')) continue;
    }
    if (matchesRouteTemplate(pathSegments, template)) return template.normalized;
  }
  return '';
}

function normalizeRoute(route: string | null | undefined, service?: string | null): string {
  if (typeof route !== 'string' || !route.trim()) return '';
  const value = route.trim();
  let pathname: string;
  try {
    pathname = new URL(value, 'http://fingerprint.local').pathname;
  } catch {
    pathname = value.split(/[?#]/, 1)[0] ?? '';
  }
  const leadingSlash = pathname.startsWith('/');
  const routeSegments = pathname.split('/').slice(leadingSlash ? 1 : 0);
  while (routeSegments.at(-1) === '') routeSegments.pop();
  const decodedSegments = routeSegments.map(decodeRouteSegment);
  const trustedRoute = normalizeTrustedRoute(decodedSegments, service);
  if (trustedRoute) return trustedRoute.slice(0, MAX_ROUTE_LENGTH);
  const normalizedSegments = routeSegments.map(normalizeRouteSegment);
  const normalized = `${leadingSlash ? '/' : ''}${normalizedSegments.join('/')}`;
  return normalized.slice(0, MAX_ROUTE_LENGTH);
}

function normalizeMethod(method: unknown): string | null {
  if (typeof method !== 'string') return null;
  const normalized = method.trim().toUpperCase();
  return HTTP_METHODS.has(normalized) ? normalized : null;
}

function normalizeKind(kind: unknown): string | null {
  if (typeof kind !== 'string' || !kind.trim()) return null;
  if (kind.length > MAX_KIND_LENGTH) return 'other';
  const normalized = kind.trim();
  return ERROR_KINDS.has(normalized) ? normalized : 'other';
}

/** Canonical boundary for metadata used by both grouping and persistence. */
export function normalizeErrorMetadata(metadata: ErrorMetadataInput | undefined): NormalizedErrorMetadata {
  const statusCode = typeof metadata?.statusCode === 'number'
    && Number.isInteger(metadata.statusCode)
    && metadata.statusCode >= 100
    && metadata.statusCode <= 599
    ? metadata.statusCode
    : null;
  return {
    method: normalizeMethod(metadata?.method),
    statusCode,
    kind: normalizeKind(metadata?.kind),
  };
}

function normalizeContext(context: FingerprintContext | undefined): string {
  if (!context) return '';
  const route = normalizeRoute(context.route, context.service);
  const { method, statusCode, kind } = normalizeErrorMetadata(context);
  const endpoint = kind === 'fetch' ? normalizeRoute(context.endpoint, context.service) : '';
  if (!route && !endpoint && method === null && statusCode === null && kind === null) return '';
  // Keep empty method/kind slots for fingerprint compatibility with existing events.
  const normalized = [route, method ?? '', statusCode, kind ?? ''];
  if (endpoint) normalized.push(endpoint);
  return JSON.stringify(normalized);
}

/** Stable 16-hex grouping key: normalized error details and optional request context. */
export function fingerprint(
  message: string,
  stack?: string | null,
  errorType?: string | null,
  context?: FingerprintContext,
): string {
  const errorBasis = `${errorType ?? ''}|${normalizeMessage(message)}|${topFrames(stack)}`;
  const requestBasis = normalizeContext(context);
  const basis = requestBasis ? `${errorBasis}|${requestBasis}` : errorBasis;
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}
