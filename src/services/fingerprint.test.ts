import { describe, expect, it } from 'vitest';
import { fingerprint } from './fingerprint';

describe('fingerprint', () => {
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
