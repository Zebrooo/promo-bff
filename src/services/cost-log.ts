/**
 * Append-only JSONL log of AI calls (one line per real OpenRouter call — cache
 * hits are NOT logged, per the feature spec). Writes through `fs.appendFile`,
 * which on POSIX is atomic for writes < PIPE_BUF (4 KB) — one line per entry
 * stays well under that. Ensures the parent directory exists on first append.
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface CostLogEntry {
  /** ISO-8601 timestamp; defaults to "now" when not provided. */
  ts: string;
  /** Whose budget is being burned (used for attribution + ratelimiting). */
  advertiserId: string;
  /** Model id the response actually came from. */
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** RUB cost, decimal — see openrouter-client for the conversion. */
  costRub: number;
}

export interface CostLog {
  /** Append one entry as a JSONL line. `ts` is filled in if omitted. */
  append(entry: Omit<CostLogEntry, 'ts'> & { ts?: string }): Promise<void>;
}

export interface CreateCostLogOpts {
  /** Absolute or cwd-relative file path. Parent dir is created on first call. */
  path: string;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
}

export function createCostLog(opts: CreateCostLogOpts): CostLog {
  const now = opts.now ?? (() => new Date());
  let dirEnsured = false;
  return {
    async append(entry) {
      if (!dirEnsured) {
        await mkdir(dirname(opts.path), { recursive: true });
        dirEnsured = true;
      }
      const full: CostLogEntry = {
        ts: entry.ts ?? now().toISOString(),
        advertiserId: entry.advertiserId,
        model: entry.model,
        tokensIn: entry.tokensIn,
        tokensOut: entry.tokensOut,
        costRub: entry.costRub,
      };
      await appendFile(opts.path, JSON.stringify(full) + '\n', 'utf8');
    },
  };
}
