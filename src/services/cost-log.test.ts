import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCostLog } from './cost-log';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'cost-log-'));
});
afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

describe('createCostLog', () => {
  it('appends one JSONL line per call', async () => {
    const path = join(tmpRoot, 'ai-cost.log');
    const log = createCostLog({ path, now: () => new Date('2026-05-31T10:00:00Z') });
    await log.append({ advertiserId: 'adv1', model: 'openai/gpt-4o-mini', tokensIn: 100, tokensOut: 50, costRub: 0.02 });
    await log.append({ advertiserId: 'adv2', model: 'openai/gpt-4o-mini', tokensIn: 200, tokensOut: 75, costRub: 0.04 });

    const contents = await readFile(path, 'utf8');
    const lines = contents.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      ts: '2026-05-31T10:00:00.000Z',
      advertiserId: 'adv1',
      model: 'openai/gpt-4o-mini',
      tokensIn: 100,
      tokensOut: 50,
      costRub: 0.02,
    });
    expect(JSON.parse(lines[1]).advertiserId).toBe('adv2');
  });

  it('fills in ts when the caller omits it', async () => {
    const path = join(tmpRoot, 'ai-cost.log');
    const log = createCostLog({ path, now: () => new Date('2026-05-31T12:00:00Z') });
    await log.append({ advertiserId: 'a', model: 'm', tokensIn: 1, tokensOut: 1, costRub: 0 });
    const entry = JSON.parse((await readFile(path, 'utf8')).trim());
    expect(entry.ts).toBe('2026-05-31T12:00:00.000Z');
  });

  it('preserves an explicit ts if the caller provides one', async () => {
    const path = join(tmpRoot, 'ai-cost.log');
    const log = createCostLog({ path });
    await log.append({ ts: '2030-01-01T00:00:00.000Z', advertiserId: 'a', model: 'm', tokensIn: 0, tokensOut: 0, costRub: 0 });
    const entry = JSON.parse((await readFile(path, 'utf8')).trim());
    expect(entry.ts).toBe('2030-01-01T00:00:00.000Z');
  });

  it('creates the parent directory on first append', async () => {
    const path = join(tmpRoot, 'nested', 'deep', 'ai-cost.log');
    const log = createCostLog({ path });
    await log.append({ advertiserId: 'a', model: 'm', tokensIn: 0, tokensOut: 0, costRub: 0 });
    const contents = await readFile(path, 'utf8');
    expect(contents.endsWith('\n')).toBe(true);
  });
});
