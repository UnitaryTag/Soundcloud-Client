import { shell } from 'electron'
import { IPC } from '@shared/ipc'
import { ok, err, AppErrorCode } from '@shared/result'
import { handle } from './register'

/**
 * `shell.openExternal` with an allowlist.
 *
 * Never pass renderer-supplied URLs to openExternal unguarded — it will happily
 * hand a `file:` or custom-scheme URL to the OS. Only https SoundCloud hosts
 * get through.
 *
 * This is also how ToS §08 attribution links are opened (credit the uploader,
 * link back to the sound's page on soundcloud.com) — and how the OAuth
 * authorize URL is launched, which is constructed by main and therefore trusted.
 */

const ALLOWED_HOSTS = ['soundcloud.com', 'sndcdn.com']

const isAllowed = (raw: string): boolean => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  return ALLOWED_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))
}

export const registerShellHandlers = (): void => {
  handle<null>(IPC.ShellOpenExternal, async (_event, url) => {
    if (typeof url !== 'string' || !isAllowed(url)) {
      return err<null>(AppErrorCode.Unknown, 'Blocked: not an https SoundCloud URL.')
    }
    await shell.openExternal(url)
    return ok(null)
  })
}
