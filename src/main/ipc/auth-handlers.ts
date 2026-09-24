import { IPC } from '@shared/ipc'
import { ok } from '@shared/result'
import type { AuthStatus } from '@shared/sc'
import type { AuthService } from '../soundcloud/auth'
import { handle } from './register'

export const registerAuthHandlers = (auth: AuthService): void => {
  handle<AuthStatus>(IPC.AuthStatus, async () => ok(auth.status()))

  // Not wrapped in toResult: `begin` already returns a Result, deliberately, so
  // that every failure mode of the interaction — decline, timeout, forged
  // state, bad credentials — arrives with a specific code the UI can act on.
  handle<AuthStatus>(IPC.AuthBegin, async () => auth.begin())

  handle<AuthStatus>(IPC.AuthSignOut, async () => ok(await auth.signOut()))
}
