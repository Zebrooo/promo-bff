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
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
