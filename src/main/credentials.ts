import { IPC } from '@shared/ipc'
import { ok } from '@shared/result'
import { redirectUriFor, type CredentialInfo } from '@shared/sc'
import { builtinCredentials, type BuiltinCredentials } from './env'
import { handle } from './ipc/register'

/**
 * Which credentials the app will use.
 *
 * Two audiences:
 *  - no Artist Pro: zero setup, the app's built-in client id is used
 *  - has Artist Pro: can supply their own pair and get their own rate-limit
 *    quota instead of sharing the app's (15k streams / 24h, per client_id)
 *
 * Resolution order is user-supplied -> built-in -> none. The user-supplied half
 * is not implemented yet; it will be stored via `safeStorage` in `creds.bin`.
 */

const DEFAULT_PORT = 8765

export const resolveCredentials = (): BuiltinCredentials | null => builtinCredentials()

const maskClientId = (clientId: string): string =>
  clientId.length <= 8 ? '•'.repeat(clientId.length) : `${clientId.slice(0, 4)}…${clientId.slice(-4)}`

/** Never carries the secret, and never the full client id. */
const describe = (): CredentialInfo => {
  const resolved = resolveCredentials()
  if (resolved === null) {
    return {
      source: 'none',
      clientIdMasked: null,
      hasSecret: false,
      redirectUri: redirectUriFor(DEFAULT_PORT)
    }
  }
  return {
    source: 'builtin',
    clientIdMasked: maskClientId(resolved.clientId),
    hasSecret: resolved.clientSecret !== undefined,
    redirectUri: redirectUriFor(resolved.redirectPort)
  }
}

export const registerCredentialHandlers = (): void => {
  handle<CredentialInfo>(IPC.CredsGet, async () => ok(describe()))
}
