import { describe, expect, it } from 'vitest';
import { TimeoutError, withTimeout } from './with-timeout';

const delay = <T>(ms: number, value: T): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

describe('withTimeout', () => {
  it('resolves with the value when the promise settles in time', async () => {
    const result = await withTimeout(delay(5, 'done'), 100, 'fast-op');
    expect(result).toBe('done');
  });

  it('rejects with a TimeoutError when the promise is too slow', async () => {
    await expect(withTimeout(delay(100, 'late'), 10, 'slow-op')).rejects.toBeInstanceOf(
      TimeoutError,
    );
  });

  it('TimeoutError carries the label and timeout for debuggability', async () => {
    const err = await withTimeout(delay(100, 'late'), 10, 'slow-op').catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.label).toBe('slow-op');
    expect(err.ms).toBe(10);
  });

  it('propagates the original rejection (not a timeout) when the promise fails fast', async () => {
    const failing = Promise.reject(new Error('boom'));
    await expect(withTimeout(failing, 100, 'op')).rejects.toThrow('boom');
  });
});
