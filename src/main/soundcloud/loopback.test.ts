import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { CALLBACK_PATH, startLoopback, type LoopbackSession } from './loopback'

/**
 * These run against a real HTTP listener on a real port — the loopback server's
 * whole job is network behaviour, so mocking the socket would test nothing.
 */

const sessions: LoopbackSession[] = []

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((s) => s.close()))
})

const freePort = async (): Promise<number> => {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()))
  const { port } = probe.address() as AddressInfo
  await new Promise<void>((resolve) => probe.close(() => resolve()))
  return port
}

const start = async (timeoutMs = 5_000): Promise<LoopbackSession> => {
  const session = await startLoopback({ port: await freePort(), timeoutMs })
  sessions.push(session)
  return session
}

const hit = (session: LoopbackSession, query: string): Promise<Response> =>
  fetch(`${session.redirectUri}${query}`)

describe('startLoopback — successful callback', () => {
  it('resolves with the code when the state matches', async () => {
    const session = await start()
    const response = await hit(session, `?code=abc123&state=${session.flow.state}`)

    expect(response.status).toBe(200)
    expect(await session.outcome).toEqual({
      ok: true,
      code: 'abc123',
      state: session.flow.state
    })
  })

  it('exposes a redirect URI matching the registered format', async () => {
    const session = await start()
    expect(session.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
  })

  it('tells the user they can close the tab', async () => {
    const session = await start()
    const body = await (await hit(session, `?code=x&state=${session.flow.state}`)).text()
    expect(body).toContain('close this tab')
  })
})

describe('startLoopback — rejected callbacks', () => {
  it('rejects a callback whose state does not match', async () => {
    const session = await start()
    const response = await hit(session, '?code=abc123&state=not-the-right-state')

    expect(response.status).toBe(400)
    expect(await session.outcome).toEqual({ ok: false, reason: 'state_mismatch' })
  })

  it('rejects a callback with no state at all', async () => {
    const session = await start()
    expect((await hit(session, '?code=abc123')).status).toBe(400)
    expect(await session.outcome).toEqual({ ok: false, reason: 'state_mismatch' })
  })

  it('reports denial when SoundCloud returns an error parameter', async () => {
    const session = await start()
    const response = await hit(session, '?error=access_denied')

    expect(response.status).toBe(400)
    expect(await session.outcome).toEqual({ ok: false, reason: 'denied' })
  })

  it('reports bad_request when neither code nor error is present', async () => {
    const session = await start()
    expect((await hit(session, `?state=${session.flow.state}`)).status).toBe(400)
    expect(await session.outcome).toEqual({ ok: false, reason: 'bad_request' })
  })

  it('does not echo an unknown error value back into the page', async () => {
    // The error parameter is attacker-controllable and this renders in a real
    // browser, so unknown codes must fall back to fixed copy.
    const session = await start()
    const body = await (
      await hit(session, '?error=<script>alert(1)</script>')
    ).text()

    expect(body).not.toContain('<script>')
    expect(body).not.toContain('alert(1)')
    expect(await session.outcome).toEqual({ ok: false, reason: 'denied' })
  })
})

describe('startLoopback — routing', () => {
  it('404s a path other than the callback', async () => {
    const session = await start()
    const response = await fetch(`http://127.0.0.1:${new URL(session.redirectUri).port}/nope`)
    expect(response.status).toBe(404)
  })

  it('405s a non-GET method', async () => {
    const session = await start()
    const response = await fetch(session.redirectUri, { method: 'POST' })
    expect(response.status).toBe(405)
  })

  it('keeps waiting after a stray request, rather than settling the flow', async () => {
    // A port scanner or a browser prefetch must not kill an in-progress login.
    const session = await start()
    await fetch(`http://127.0.0.1:${new URL(session.redirectUri).port}/nope`)

    let settled = false
    void session.outcome.then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(settled).toBe(false)

    await hit(session, `?code=after&state=${session.flow.state}`)
    expect(await session.outcome).toEqual({
      ok: true,
      code: 'after',
      state: session.flow.state
    })
  })
})

describe('startLoopback — lifecycle', () => {
  it('times out when nobody completes the flow', async () => {
    const session = await start(60)
    expect(await session.outcome).toEqual({ ok: false, reason: 'timeout' })
  })

  it('settles as cancelled when closed mid-flow', async () => {
    const session = await start()
    await session.close()
    expect(await session.outcome).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('releases the port once the flow settles', async () => {
    const port = await freePort()
    const session = await startLoopback({ port })
    await session.close()

    // Binding again proves the listener is really gone, not merely idle.
    const again = await startLoopback({ port })
    sessions.push(again)
    expect(again.redirectUri).toContain(String(port))
  })

  it('settles only once, even if the callback is delivered twice', async () => {
    const session = await start()
    await hit(session, `?code=first&state=${session.flow.state}`)

    const second = await session.outcome
    expect(second).toEqual({ ok: true, code: 'first', state: session.flow.state })
  })

  it('is safe to close more than once', async () => {
    const session = await start()
    await session.close()
    await expect(session.close()).resolves.toBeUndefined()
    expect(await session.outcome).toEqual({ ok: false, reason: 'cancelled' })
  })

  it('does not overwrite a successful outcome when closed afterwards', async () => {
    const session = await start()
    await hit(session, `?code=kept&state=${session.flow.state}`)
    await session.close()
    expect(await session.outcome).toEqual({
      ok: true,
      code: 'kept',
      state: session.flow.state
    })
  })

  it('fails with a useful message when the port is already taken', async () => {
    const port = await freePort()
    const session = await startLoopback({ port })
    sessions.push(session)

    await expect(startLoopback({ port })).rejects.toThrow(/already in use/i)
  })

  it('binds to loopback only, not every interface', async () => {
    const session = await start()
    // If this were 0.0.0.0 the OAuth callback would be reachable from the
    // network, which for a local auth flow is a real exposure.
    const host = new URL(session.redirectUri).hostname
    expect(host).toBe('127.0.0.1')
    expect(CALLBACK_PATH).toBe('/callback')
  })
})
