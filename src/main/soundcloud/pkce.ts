import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

/**
 * PKCE (RFC 7636) and the OAuth `state` parameter.
 *
 * Deliberately free of any Electron import so it is testable in plain Node —
 * the S256 derivation has published test vectors and should stay verifiable.
 *
 * Nothing here is persisted. The verifier is a one-time secret that must not
 * touch disk, the renderer, or localStorage; if the app quits mid-flow the
 * verifier is simply lost, and the next launch is signed out. That is the
 * correct failure mode, not a bug to work around.
 */

/** RFC 7636 §4.1: 43–128 characters from the unreserved set. 32 bytes → 43 base64url chars. */
export const createVerifier = (): string => randomBytes(32).toString('base64url')

/**
 * S256 challenge: base64url(SHA-256(ASCII(verifier))).
 *
 * The `'ascii'` encoding is explicit because the verifier is restricted to
 * unreserved ASCII characters — a default utf8 encode would give the same
 * bytes for valid verifiers but would silently accept a verifier containing
 * non-ASCII, producing a challenge the server can never reproduce.
 */
export const challengeFor = (verifier: string): string =>
  createHash('sha256').update(verifier, 'ascii').digest('base64url')

export const createState = (): string => randomBytes(16).toString('base64url')

/**
 * Constant-time state comparison.
 *
 * Length is checked first because `timingSafeEqual` throws on mismatched
 * lengths — comparing lengths leaks only information the attacker already has,
 * since they chose the value they sent.
 */
export const stateMatches = (expected: string, received: string | null): boolean => {
  if (received === null) return false
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export type PkceFlow = {
  verifier: string
  challenge: string
  state: string
}

export const createFlow = (): PkceFlow => {
  const verifier = createVerifier()
  return { verifier, challenge: challengeFor(verifier), state: createState() }
}
