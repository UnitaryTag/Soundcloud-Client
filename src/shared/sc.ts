/**
 * SoundCloud domain types.
 *
 * URNs are the primary key for every resource. Numeric `id` was deprecated in
 * April 2025 with degraded behaviour after 2025-06-30 — never key a map by it,
 * and never parse the numeric portion out of a URN.
 */

export type Urn = `soundcloud:${string}:${number}`

const URN_RE = /^soundcloud:[a-z_]+:\d+$/

export const isUrn = (value: unknown): value is Urn =>
  typeof value === 'string' && URN_RE.test(value)

/**
 * Build a track URN from a bare numeric id.
 *
 * Validates rather than casts: a non-numeric id produces a malformed URN that
 * would otherwise fail much later, as an opaque 404 from the API.
 */
export const trackUrn = (id: string | number): Urn => {
  const urn = `soundcloud:tracks:${id}`
  if (!isUrn(urn)) throw new Error(`Not a valid track URN: ${urn}`)
  return urn
}

export type UserSummary = {
  /**
   * Null when SoundCloud omits it. Display metadata only — never used as a key,
   * so a missing value degrades a link rather than breaking playback.
   */
  urn: Urn | null
  username: string
  permalinkUrl: string
  avatarUrl: string | null
}

export type TrackSummary = {
  urn: Urn
  title: string
  durationMs: number
  permalinkUrl: string
  artworkUrl: string | null
  user: UserSummary
  streamable: boolean
}

export type AuthStatus =
  | { state: 'signed-out' }
  | {
      state: 'signed-in'
      /**
       * Null when the session is valid but the profile could not be loaded —
       * typically offline at launch. Reporting `signed-out` instead would throw
       * away a working session over a network blip.
       */
      user: UserSummary | null
      /** Epoch ms. */
      expiresAt: number
    }

/** A cursor-paginated slice of a collection. `next` is opaque — never construct one. */
export type Page<T> = {
  items: T[]
  next: string | null
}

export type CredentialSource = 'user' | 'builtin' | 'none'

/** Never carries the secret, and never the full client id. */
export type CredentialInfo = {
  source: CredentialSource
  clientIdMasked: string | null
  hasSecret: boolean
  /**
   * The value that must be registered verbatim on the SoundCloud app. Shown in
   * the UI because a mismatch is the single most likely setup failure.
   */
  redirectUri: string
}

export const redirectUriFor = (port: number): string => `http://127.0.0.1:${port}/callback`
