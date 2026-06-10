import { describe, expect, it } from 'vitest';
import { Checker } from './Checker';
import { makeCheckContext } from '../../test-utils';

class PassChecker extends Checker {
  readonly name = 'pass';
  expect() { return 'always true'; }
  check() { return true; }
}
class FailChecker extends Checker {
  readonly name = 'fail';
  expect() { return 'always false'; }
  check() { return false; }
}
class SkipChecker extends Checker {
  readonly name = 'skip';
  expect() { return 'n/a'; }
  shouldSkip() { return 'no config' as const; }
  check() { return false; } // would fail, but skipped
}
class ThrowChecker extends Checker {
  readonly name = 'boom';
  expect() { return 'n/a'; }
  check(): boolean { throw new Error('boom'); }
}

describe('Checker.run', () => {
  it('returns the check() result', async () => {
    expect(await new PassChecker().run(makeCheckContext(), {})).toBe(true);
    expect(await new FailChecker().run(makeCheckContext(), {})).toBe(false);
  });
  it('returns true (eligible) when shouldSkip gives a reason, without running check', async () => {
    expect(await new SkipChecker().run(makeCheckContext(), {})).toBe(true);
  });
  it('fails closed (false) when check throws', async () => {
    expect(await new ThrowChecker().run(makeCheckContext(), {})).toBe(false);
  });
});
