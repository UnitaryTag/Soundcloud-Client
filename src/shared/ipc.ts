import type { Result } from './result'
import type { AuthStatus, CredentialInfo, Page, TrackSummary } from './sc'

/** Channel names. Shared so main and preload cannot drift apart. */
export const IPC = {
  ShellOpenExternal: 'shell:openExternal',

  CredsGet: 'creds:get',

  AuthStatus: 'auth:status',
  AuthBegin: 'auth:begin',
  AuthCancel: 'auth:cancel',
  AuthSignOut: 'auth:signOut',
  /** main -> renderer push, not an invoke. Fires on sign-in, sign-out, and expiry. */
  AuthChanged: 'auth:changed',

  CatalogSearch: 'catalog:search',
  CatalogResolve: 'catalog:resolve',

  MediaResolve: 'media:resolve',
  MediaFetch: 'media:fetch'
} as const

/**
 * A playlist or segment fetched on the renderer's behalf.
 *
 * `url` is the post-redirect URL, which hls.js requires to resolve relative
 * child URIs. Exactly one of `text`/`bytes` is present, decided by content type.
 */
export type MediaChunk = {
  status: number
  url: string
  contentType: string | null
  text?: string
  bytes?: Uint8Array
}

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * The object exposed on `window.sc` by the preload bridge.
 *
 * Only serializable data crosses this boundary. Functions are proxied; every
 * other value is copied and frozen, and class instances arrive as plain objects.
 * Nothing here carries a token, a client secret, or a client id — the renderer
 * has no credentials and makes no authenticated requests of its own.
 */
export type ScApi = {
  shell: {
    /** Opens a URL in the system browser. Main enforces an https + host allowlist. */
    openExternal: (url: string) => Promise<Result<null>>
  }

  creds: {
    get: () => Promise<Result<CredentialInfo>>
  }

  auth: {
    status: () => Promise<Result<AuthStatus>>
    /** Opens the system browser and runs the PKCE flow. */
    begin: () => Promise<Result<AuthStatus>>
    /**
     * Abandons an in-progress sign-in. Without this the UI is stuck until the
     * five-minute timeout, and the callback port stays bound so a retry cannot
     * even start.
     */
    cancel: () => Promise<Result<null>>
    signOut: () => Promise<Result<AuthStatus>>
    /**
     * Subscribe to out-of-band auth changes. Returns an unsubscriber — call it
     * on unmount, or React StrictMode's double-mount will leak listeners.
     */
    onChanged: (cb: (status: AuthStatus) => void) => () => void
  }

  catalog: {
    search: (query: string, cursor?: string) => Promise<Result<Page<TrackSummary>>>
    /** Resolves a soundcloud.com URL to a track. */
    resolve: (url: string) => Promise<Result<TrackSummary>>
  }

  media: {
    /**
     * Resolves a track to a playable HLS URL.
     *
     * Resolved fresh each time rather than cached: these URLs are signed with
     * an `expires` parameter, and SoundCloud has shipped ones already expired.
     * A cached resolution is a time bomb.
     */
    resolve: (trackUrn: string) => Promise<Result<StreamResolution>>
    /**
     * Fetches media with the user's credentials attached.
     *
     * The renderer cannot make these requests itself — they need an
     * `Authorization: OAuth` header, and the token lives only in main. Main
     * enforces https and a host allowlist, on redirect targets as well.
     */
    fetch: (url: string, range?: string) => Promise<Result<MediaChunk>>
  }
}

export type StreamResolution = {
  url: string
  /** Epoch ms, when the URL carries an `expires` parameter. */
  expiresAt: number | null
}
