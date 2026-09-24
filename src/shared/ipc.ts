import type { Result } from './result'
import type { CredentialInfo, AuthStatus } from './sc'

/** Channel names. Shared so main and preload can't drift. */
export const IPC = {
  ShellOpenExternal: 'shell:openExternal',
  CredsGet: 'creds:get',

  /** main -> renderer push, not an invoke. Fired when auth state changes out of band. */
  AuthChanged: 'auth:changed'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * The object exposed on `window.sc` by the preload bridge.
 *
 * Only serializable data crosses this boundary. Functions are proxied; every
 * other value is copied and frozen, and class instances arrive as plain objects.
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
    /** Subscribe to out-of-band auth changes. Returns an unsubscriber. */
    onChanged: (cb: (status: AuthStatus) => void) => () => void
  }
}
