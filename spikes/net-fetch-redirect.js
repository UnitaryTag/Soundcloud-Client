/**
 * Spike: does `Authorization` survive a cross-origin redirect?
 *
 * SoundCloud's `/tracks/{urn}/streams` returns a URL that 302s to a signed CDN
 * host. Whether the auth header is re-sent to that second host decides how the
 * media layer must be written:
 *
 *   - header survives  -> a plain fetch works, redirects handled for us
 *   - header stripped  -> we must follow redirects manually and re-apply the
 *                         header only to hosts we trust
 *
 * Electron documents neither, and `net.fetch` goes through Chromium rather than
 * Node's undici, so the Node behaviour is not a guide. Hence measuring it.
 *
 * Run inside Electron, not Node:
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron spikes/net-fetch-redirect.js
 */

const { app, net } = require('electron')
const http = require('node:http')

const TOKEN = 'OAuth spike-token-value'

const serve = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })

const close = (instances) =>
  Promise.all(
    instances.map((i) => new Promise((resolve) => i.server.close(() => resolve())))
  )

/** Records the auth header each request actually carried. */
const recorder = (label) => {
  const seen = []
  return {
    seen,
    handler: (req, res) => {
      seen.push({ label, path: req.url, auth: req.headers.authorization ?? null })
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('ok')
    }
  }
}

const attempt = async (name, fn) => {
  try {
    const result = await fn()
    return { name, ok: true, result }
  } catch (cause) {
    return { name, ok: false, error: String(cause && cause.message ? cause.message : cause) }
  }
}

app.whenReady().then(async () => {
  const target = recorder('target')
  const targetServer = await serve(target.handler)
  const targetUrl = `http://127.0.0.1:${targetServer.port}/final`

  // Redirects across origins (different port == different origin).
  const crossOrigin = await serve((req, res) => {
    res.writeHead(302, { location: targetUrl })
    res.end()
  })

  const results = []
  const findings = {}

  // --- 1. Electron net.fetch, cross-origin redirect, default redirect mode ---
  target.seen.length = 0
  results.push(
    await attempt('net.fetch cross-origin (default redirect)', async () => {
      const response = await net.fetch(`http://127.0.0.1:${crossOrigin.port}/start`, {
        headers: { authorization: TOKEN }
      })
      return { status: response.status, headers: [...response.headers].length }
    })
  )
  findings['net.fetch + cross-origin'] = target.seen.map((s) => s.auth)

  // --- 2. Electron net.fetch, redirect: 'manual' ---
  target.seen.length = 0
  results.push(
    await attempt('net.fetch cross-origin (redirect: manual)', async () => {
      const response = await net.fetch(`http://127.0.0.1:${crossOrigin.port}/start`, {
        headers: { authorization: TOKEN },
        redirect: 'manual'
      })
      return {
        status: response.status,
        location: response.headers.get('location') === null ? 'ABSENT' : 'present'
      }
    })
  )
  findings['net.fetch manual + cross-origin'] = target.seen.map((s) => s.auth)

  // --- 3. Node global fetch, for contrast ---
  target.seen.length = 0
  results.push(
    await attempt('node fetch cross-origin (default redirect)', async () => {
      const response = await fetch(`http://127.0.0.1:${crossOrigin.port}/start`, {
        headers: { authorization: TOKEN }
      })
      return { status: response.status }
    })
  )
  findings['node fetch + cross-origin'] = target.seen.map((s) => s.auth)

  console.log('\n=== request outcomes ===')
  for (const r of results) {
    console.log(r.ok ? `  ok   ${r.name} -> ${JSON.stringify(r.result)}` : `  FAIL ${r.name} -> ${r.error}`)
  }

  console.log('\n=== who received the Authorization header ===')
  for (const [label, auths] of Object.entries(findings)) {
    const described =
      auths.length === 0
        ? 'no request reached the target'
        : auths.map((a) => (a === null ? 'STRIPPED' : 'PRESENT')).join(', ')
    console.log(`  ${label}: ${described}`)
  }

  console.log('\n=== verdict ===')
  const crossOriginAuth = findings['net.fetch + cross-origin']
  if (crossOriginAuth.length > 0 && crossOriginAuth.every((a) => a === TOKEN)) {
    console.log('  net.fetch preserves Authorization across a cross-origin 302.')
    console.log('  -> the media layer can follow redirects implicitly.')
  } else if (crossOriginAuth.length > 0) {
    console.log('  net.fetch STRIPS Authorization across a cross-origin 302.')
    console.log('  -> the media layer must follow redirects manually and re-apply')
    console.log('     the header itself, restricted to trusted hosts.')
  }

  await close([targetServer, crossOrigin])
  app.quit()
})
