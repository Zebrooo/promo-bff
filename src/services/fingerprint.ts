import { createHash } from 'node:crypto';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

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

/** Stable 16-hex grouping key: normalized message + top stack frames + type. */
export function fingerprint(message: string, stack?: string | null, errorType?: string | null): string {
  const basis = `${errorType ?? ''}|${normalizeMessage(message)}|${topFrames(stack)}`;
  return createHash('sha1').update(basis).digest('hex').slice(0, 16);
}
