import type { Result } from './result'
import type { AuthStatus, CredentialInfo, Page, TrackSummary } from './sc'

/** Channel names. Shared so main and preload cannot drift apart. */
export const IPC = {
  ShellOpenExternal: 'shell:openExternal',

  CredsGet: 'creds:get',

  AuthStatus: 'auth:status',
  AuthBegin: 'auth:begin',
  AuthSignOut: 'auth:signOut',
  /** main -> renderer push, not an invoke. Fires on sign-in, sign-out, and expiry. */
  AuthChanged: 'auth:changed',

  CatalogSearch: 'catalog:search',
  CatalogResolve: 'catalog:resolve'
} as const

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
}
