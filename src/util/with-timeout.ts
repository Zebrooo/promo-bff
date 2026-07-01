/** Thrown when a wrapped promise does not settle within the allotted time. */
export class TimeoutError extends Error {
  constructor(
    readonly label: string,
    readonly ms: number,
  ) {
    super(`${label} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Races a promise against a timer. If `promise` does not settle within `ms`,
 * rejects with a TimeoutError (labelled for logs). The timer is always cleared so
 * it can't keep the process alive. This is the single place external-service
 * timeouts are enforced — every service client wraps its calls with it.
 *
 * Bug fix (double-charge): the optional `controller` is aborted when the timeout
 * fires. Callers that pass an AbortController into fetch() will have the
 * underlying HTTP request cancelled, not just the Promise.race winner swapped.
 * Without this, a slow-but-successful Supabase RPC completes after the BFF
 * already returned a 502, causing the storefront to retry → two billing charges
 * for one impression. Existing callers that pass no controller are unaffected.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  controller?: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller?.abort();
      reject(new TimeoutError(label, ms));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
