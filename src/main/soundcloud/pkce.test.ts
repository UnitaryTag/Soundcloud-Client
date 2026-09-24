import { describe, expect, it } from 'vitest'
import {
  challengeFor,
  createFlow,
  createState,
  createVerifier,
  stateMatches
} from './pkce'

describe('challengeFor', () => {
  it('reproduces the RFC 7636 Appendix B S256 test vector', () => {
    // The canonical vector. If the encoding or digest ever drifts, this catches
    // it — and the only other symptom would be an opaque invalid_grant from
    // SoundCloud at token-exchange time.
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(challengeFor(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('is deterministic for the same verifier', () => {
    const verifier = createVerifier()
    expect(challengeFor(verifier)).toBe(challengeFor(verifier))
  })

  it('produces base64url without padding', () => {
    expect(challengeFor(createVerifier())).toMatch(/^[A-Za-z0-9\-_]{43}$/)
  })
})

describe('createVerifier', () => {
  it('stays within the RFC 7636 length bounds of 43 to 128', () => {
    for (let i = 0; i < 100; i += 1) {
      const length = createVerifier().length
      expect(length).toBeGreaterThanOrEqual(43)
      expect(length).toBeLessThanOrEqual(128)
    }
  })

  it('uses only unreserved characters, so it survives URL encoding intact', () => {
    for (let i = 0; i < 100; i += 1) {
      expect(createVerifier()).toMatch(/^[A-Za-z0-9\-_]+$/)
    }
  })

  it('does not repeat', () => {
    const seen = new Set(Array.from({ length: 500 }, () => createVerifier()))
    expect(seen.size).toBe(500)
  })
})

describe('stateMatches', () => {
  it('accepts an exact match', () => {
    const state = createState()
    expect(stateMatches(state, state)).toBe(true)
  })

  it('rejects a null state, as sent when the user denies authorization', () => {
    expect(stateMatches(createState(), null)).toBe(false)
  })

  it('rejects a different state of the same length', () => {
    const a = createState()
    let b = createState()
    while (b === a) b = createState()
    expect(stateMatches(a, b)).toBe(false)
  })

  it('rejects a length mismatch without throwing', () => {
    // timingSafeEqual throws on unequal lengths; the guard in stateMatches is
    // what stops a malformed callback from crashing the loopback server.
    expect(() => stateMatches(createState(), 'short')).not.toThrow()
    expect(stateMatches(createState(), 'short')).toBe(false)
    expect(stateMatches(createState(), '')).toBe(false)
  })
})

describe('createFlow', () => {
  it('wires the challenge to its own verifier', () => {
    const flow = createFlow()
    expect(flow.challenge).toBe(challengeFor(flow.verifier))
  })

  it('returns independent values per call', () => {
    const a = createFlow()
    const b = createFlow()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.state).not.toBe(b.state)
  })
})
