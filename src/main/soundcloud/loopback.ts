import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { redirectUriFor } from '@shared/sc'
import { log } from '../logger'
import { createFlow, stateMatches, type PkceFlow } from './pkce'

/**
 * Loopback OAuth callback server (RFC 8252 §7.3).
 *
 * Why loopback and not a custom protocol scheme: on macOS a custom scheme only
 * works from a packaged app, so the whole auth flow would be untestable in
 * `npm run dev`. Loopback behaves identically in dev and production, and
 * RFC 8252 explicitly recommends it for desktop.
 *
 * The server binds to the loopback interface only. It is reachable by any
 * process on this machine, so the callback is treated as untrusted input:
 * the state is verified before the code is accepted, and nothing from the
 * query string is echoed back into the response body.
 */

export const CALLBACK_PATH = '/callback'

/** Matches SoundCloud's own sc-api-auth.mjs, and must match the registered redirect URI exactly. */
export const DEFAULT_PORT = 8765

const DEFAULT_TIMEOUT_MS = 300_000

export type LoopbackFailure =
  /** The user clicked Deny, or SoundCloud refused. */
  | 'denied'
  /** Nobody completed the flow before the deadline. */
  | 'timeout'
  /** `close()` was called while the flow was still pending. */
  | 'cancelled'
  /** A callback arrived carrying a state we did not issue. */
  | 'state_mismatch'
  /** Right path, but no usable `code` or `error` parameter. */
  | 'bad_request'

export type LoopbackOutcome =
  | { ok: true; code: string; state: string }
  | { ok: false; reason: LoopbackFailure }

export type LoopbackSession = {
  /** The exact string that must be registered on the SoundCloud app. */
  redirectUri: string
  flow: PkceFlow
  /** Settles exactly once, whether by callback, timeout, or close(). */
  outcome: Promise<LoopbackOutcome>
  /** Idempotent. Closing a pending flow settles it as `cancelled`. */
  close: () => Promise<void>
}

/** Known OAuth error codes, mapped to copy. Raw query text is never echoed back. */
const DENIAL_MESSAGES: Record<string, string> = {
  access_denied: 'You declined the authorization request.',
  invalid_request: 'SoundCloud rejected the request as malformed.',
  unauthorized_client: 'This app is not authorized to use that redirect URI.',
  unsupported_response_type: 'The app requested an unsupported response type.',
  invalid_scope: 'The app requested a scope SoundCloud does not allow.',
  server_error: 'SoundCloud reported a server error.',
  temporarily_unavailable: 'SoundCloud is temporarily unavailable.'
}

const page = (heading: string, detail: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${heading}</title>
    <style>
      body { margin: 0; display: grid; place-items: center; min-height: 100vh;
             background: #0d0d10; color: #ececf1;
             font: 15px/1.5 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
      main { max-width: 30rem; padding: 2rem; text-align: center; }
      h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 .5rem; }
      p { color: #8b8b99; margin: 0; }
    </style>
  </head>
  <body><main><h1>${heading}</h1><p>${detail}</p></main></body>
</html>
`

const send = (res: ServerResponse, status: number, heading: string, detail: string): void => {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  })
  res.end(page(heading, detail))
}

/** True when the request is a GET for exactly the callback path, ignoring query. */
const isCallback = (req: IncomingMessage): boolean => {
  const path = (req.url ?? '').split('?')[0]
  return path === CALLBACK_PATH
}

export const startLoopback = async (options: {
  port?: number
  timeoutMs?: number
}): Promise<LoopbackSession> => {
  const port = options.port ?? DEFAULT_PORT
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const flow = createFlow()

  let settle!: (outcome: LoopbackOutcome) => void
  const outcome = new Promise<LoopbackOutcome>((resolve) => {
    settle = resolve
  })

  let settled = false
  let timer: NodeJS.Timeout | undefined

  const server: Server = createServer((req, res) => {
    if (!isCallback(req)) {
      send(res, 404, 'Not found', 'This address only handles the SoundCloud sign-in callback.')
      return
    }
    if (req.method !== 'GET') {
      send(res, 405, 'Method not allowed', 'The sign-in callback expects a GET request.')
      return
    }

    const url = new URL(req.url ?? '', `http://127.0.0.1:${port}`)
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')

    if (error !== null) {
      // Deliberately mapped, not echoed — `error` is attacker-controllable text
      // and this response renders in a real browser.
      const detail = DENIAL_MESSAGES[error] ?? 'SoundCloud did not complete the sign-in.'
      send(res, 400, 'Sign-in was not completed', `${detail} You can close this tab.`)
      finish({ ok: false, reason: 'denied' })
      return
    }

    if (code === null) {
      send(res, 400, 'Sign-in failed', 'No authorization code was returned. You can close this tab.')
      finish({ ok: false, reason: 'bad_request' })
      return
    }

    // A missing state is also how a callback that never round-tripped through us
    // arrives. Testing it explicitly narrows the type for the success path below.
    if (state === null || !stateMatches(flow.state, state)) {
      // A local process could reach this port with a forged callback. The state
      // check is what stops a code we did not ask for from being exchanged.
      log.warn('loopback callback discarded: state did not match')
      send(res, 400, 'Sign-in failed', 'The response could not be verified. You can close this tab.')
      finish({ ok: false, reason: 'state_mismatch' })
      return
    }

    send(res, 200, 'Signed in', 'You can close this tab and return to the app.')
    finish({ ok: true, code, state })
  })

  const closeServer = async (): Promise<void> => {
    if (timer !== undefined) clearTimeout(timer)
    if (!server.listening) return
    await new Promise<void>((resolve) => {
      // Node 18.2+. Without this, a keep-alive connection from the browser holds
      // the listener open and the process cannot exit cleanly.
      server.closeAllConnections()
      server.close(() => resolve())
    })
  }

  const finish = (result: LoopbackOutcome): void => {
    if (settled) return
    settled = true
    settle(result)
    // The response has already been written by the caller; closing on the next
    // tick lets it flush before the socket is torn down.
    setImmediate(() => {
      void closeServer()
    })
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', (cause: NodeJS.ErrnoException) => {
      if (cause.code === 'EADDRINUSE') {
        reject(
          new Error(
            `Port ${port} is already in use. Another instance may be running, or the port is taken — set SC_REDIRECT_PORT to a free one.`
          )
        )
        return
      }
      reject(cause)
    })
    // 127.0.0.1 explicitly, never 0.0.0.0: this must not be reachable off-box.
    server.listen(port, '127.0.0.1', () => resolve())
  })

  timer = setTimeout(() => {
    log.warn(`loopback: no callback within ${timeoutMs}ms, giving up`)
    finish({ ok: false, reason: 'timeout' })
  }, timeoutMs)
  // Do not let the timer alone hold the event loop open.
  timer.unref?.()

  return {
    redirectUri: redirectUriFor(port),
    flow,
    outcome,
    close: async (): Promise<void> => {
      finish({ ok: false, reason: 'cancelled' })
      await closeServer()
    }
  }
}
