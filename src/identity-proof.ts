import { createPublicKey, verify as edVerify, type KeyObject } from 'node:crypto';

const IDENTITY_PROOF_PREFIX = 'pi1';
const IDENTITY_PROOF_PURPOSE = 'promo-account-continuity';
const MAX_PROOF_LENGTH = 1024;
const MAX_PROOF_LIFETIME_SEC = 60;
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface IdentityProofVerifier {
  verify(proof: string, expectedSub: string, authenticatedSrc: string): boolean;
}

export interface IdentityProofVerifierOptions {
  /** Base64 DER SPKI Ed25519 public key (same key family as service tickets). */
  publicKey: string;
  expectedDst: string;
  /** Override clock in tests. */
  now?: () => number;
  /** Allowed clock skew in seconds (default 5). */
  skewSec?: number;
}

/**
 * Verify a detached `pi1.<iat>.<exp>.<signature-b64url>` proof. The account id
 * is intentionally absent from the token text; it comes from the request and
 * is cryptographically bound into the canonical signature bytes:
 *
 *   "promo-account-continuity\\0" + userId + "\\0" + iat + "\\0" +
 *   exp + "\\0" + authenticated service-ticket src + "\\0" + dst
 *
 * This is domain-separated from `st1` service tickets despite sharing their
 * Ed25519 key pair. A maximum 60-second lifetime limits replay if the detached
 * proof is exposed; the longer-lived continuity cookie stays inside web.
 */
export function createIdentityProofVerifier(opts: IdentityProofVerifierOptions): IdentityProofVerifier {
  const publicKey: KeyObject = createPublicKey({
    key: Buffer.from(opts.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  const now = opts.now ?? Date.now;
  const skewSec = opts.skewSec ?? 5;

  return {
    verify(proof, expectedSub, authenticatedSrc) {
      if (!authenticatedSrc) return false;
      // Account ids come from Supabase Auth and must use its canonical lower-case
      // UUID representation. Do not sign/accept arbitrary datasource keys.
      if (!CANONICAL_UUID.test(expectedSub)) return false;
      if (typeof proof !== 'string' || proof.length === 0 || proof.length > MAX_PROOF_LENGTH) return false;
      const parts = proof.split('.');
      if (parts.length !== 4 || parts[0] !== IDENTITY_PROOF_PREFIX) return false;
      const [, encodedIat, encodedExp, encodedSignature] = parts;
      // Canonical unsigned decimal form only: no signs, leading zeros or floats.
      if (!/^(0|[1-9]\d*)$/.test(encodedIat) || !/^(0|[1-9]\d*)$/.test(encodedExp)) return false;
      if (!/^[A-Za-z0-9_-]+$/.test(encodedSignature)) return false;
      const signature = Buffer.from(encodedSignature, 'base64url');
      if (signature.toString('base64url') !== encodedSignature) return false;
      const iat = Number(encodedIat);
      const exp = Number(encodedExp);
      if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return false;
      if (exp <= iat || exp - iat > MAX_PROOF_LIFETIME_SEC) return false;
      const nowSec = Math.floor(now() / 1000);
      if (nowSec > exp + skewSec || nowSec + skewSec < iat) return false;

      const canonical = [
        IDENTITY_PROOF_PURPOSE,
        expectedSub,
        encodedIat,
        encodedExp,
        authenticatedSrc,
        opts.expectedDst,
      ].join('\0');

      try {
        return edVerify(
          null,
          Buffer.from(canonical),
          publicKey,
          signature,
        );
      } catch {
        return false;
      }
    },
  };
}
