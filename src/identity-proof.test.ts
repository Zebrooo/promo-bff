import { createPrivateKey, sign as edSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateKeyPair } from '@zebrooo/service-ticket';
import { createIdentityProofVerifier } from './identity-proof';

const NOW_MS = 1_800_000_000_000;
const NOW_SEC = Math.floor(NOW_MS / 1000);
const SRC = 'abkhaz-auto';
const DST = 'promo-bff';
const USER_ID = 'a1111111-b111-c111-d111-e11111111111';
const { publicKey, privateKey } = generateKeyPair();

function issue(over: {
  userId?: string;
  iat?: number;
  exp?: number;
  src?: string;
  dst?: string;
} = {}): string {
  const userId = over.userId ?? USER_ID;
  const iat = over.iat ?? NOW_SEC;
  const exp = over.exp ?? iat + 60;
  const src = over.src ?? SRC;
  const dst = over.dst ?? DST;
  const canonical = ['promo-account-continuity', userId, String(iat), String(exp), src, dst].join('\0');
  const key = createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const signature = edSign(null, Buffer.from(canonical), key).toString('base64url');
  return `pi1.${iat}.${exp}.${signature}`;
}

const verifier = createIdentityProofVerifier({ publicKey, expectedDst: DST, now: () => NOW_MS });

describe('account continuity identity proof', () => {
  it('accepts a current proof bound to user id, service-ticket src and BFF dst', () => {
    expect(verifier.verify(issue(), USER_ID, SRC)).toBe(true);
  });

  it('rejects a proof replayed for another user id or service-ticket caller', () => {
    expect(verifier.verify(issue(), '22222222-2222-2222-2222-222222222222', SRC)).toBe(false);
    expect(verifier.verify(issue(), USER_ID, 'other-service')).toBe(false);
  });

  it('rejects non-UUID and non-canonical upper-case account ids', () => {
    expect(verifier.verify(issue({ userId: 'account-1' }), 'account-1', SRC)).toBe(false);
    const upper = USER_ID.toUpperCase();
    expect(verifier.verify(issue({ userId: upper }), upper, SRC)).toBe(false);
  });

  it('rejects wrong dst, tampering and malformed canonical timestamps', () => {
    expect(verifier.verify(issue({ dst: 'other-bff' }), USER_ID, SRC)).toBe(false);
    expect(verifier.verify(`${issue()}x`, USER_ID, SRC)).toBe(false);
    expect(verifier.verify(`pi1.0${NOW_SEC}.${NOW_SEC + 60}.bad`, USER_ID, SRC)).toBe(false);
    // Node's decoder accepts alternate padding bits that decode to the same 64
    // signature bytes; the contract admits only the canonical base64url form.
    const [prefix, iat, exp, sig] = issue().split('.');
    const canonicalTail = 'AQgw'.indexOf(sig.at(-1) as string);
    expect(canonicalTail).toBeGreaterThanOrEqual(0);
    const nonCanonicalTail = 'BRhx'[canonicalTail];
    expect(verifier.verify(`${prefix}.${iat}.${exp}.${sig.slice(0, -1)}${nonCanonicalTail}`, USER_ID, SRC)).toBe(false);
  });

  it('rejects expired, not-yet-valid, inverted and over-60-second proofs', () => {
    expect(verifier.verify(issue({ iat: NOW_SEC - 70, exp: NOW_SEC - 10 }), USER_ID, SRC)).toBe(false);
    expect(verifier.verify(issue({ iat: NOW_SEC + 6, exp: NOW_SEC + 60 }), USER_ID, SRC)).toBe(false);
    expect(verifier.verify(issue({ iat: NOW_SEC, exp: NOW_SEC - 1 }), USER_ID, SRC)).toBe(false);
    expect(verifier.verify(issue({ iat: NOW_SEC, exp: NOW_SEC + 61 }), USER_ID, SRC)).toBe(false);
  });
});
