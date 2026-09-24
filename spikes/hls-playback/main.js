/**
 * Spike: does audio actually play through the real IpcLoader?
 *
 * Serves a local HLS fixture and drives hls.js with the *production* loader —
 * bundled from src/renderer/src/player/ipc-loader.ts with esbuild, not a copy —
 * so a passing run exercises the same code the app ships: hls.js custom Loader
 * interface, IPC round trip, byte slicing, and MSE decode.
 *
 * What this cannot prove is SoundCloud's own behaviour: its URLs, its auth, and
 * whether its playlists look like this fixture. It proves the plumbing.
 *
 *   env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron spikes/hls-playback/main.js
 */

const { app, BrowserWindow, ipcMain, net, session } = require('electron')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const FIXTURE = '/tmp/sc-fixture'
const ROOT = path.join(__dirname, '..', '..')
const HLS_JS = path.join(ROOT, 'node_modules', 'hls.js', 'dist', 'hls.min.js')
const LOADER_TS = path.join(ROOT, 'src', 'renderer', 'src', 'player', 'ipc-loader.ts')

const SPOOFED_TOKEN = 'OAuth spike-token-value'
const PLAY_MS = 12_000

const stats = {
  playlistHits: 0,
  segmentHits: 0,
  initHits: 0,
  authSeen: [],
  paths: []
}

const CONTENT_TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.js': 'text/javascript',
  '.html': 'text/html'
}

const bundleLoader = () => {
  const esbuild = require('esbuild')
  const result = esbuild.buildSync({
    entryPoints: [LOADER_TS],
    bundle: true,
    format: 'esm',
    write: false,
    target: 'es2022',
    logLevel: 'silent'
  })
  return result.outputFiles[0].text
}

const serve = (handler) =>
  new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })

app.whenReady().then(async () => {
  const loaderSource = bundleLoader()

  const { server, port } = await serve((req, res) => {
    const url = (req.url || '/').split('?')[0]
    const send = (body, type, status = 200) => {
      res.writeHead(status, { 'content-type': type })
      res.end(body)
    }

    if (url === '/' || url === '/page.html') {
      return send(fs.readFileSync(path.join(__dirname, 'page.html')), CONTENT_TYPES['.html'])
    }
    if (url === '/hls.js') return send(fs.readFileSync(HLS_JS), CONTENT_TYPES['.js'])
    if (url === '/loader.js') return send(loaderSource, CONTENT_TYPES['.js'])
    if (url === '/page.js') {
      return send(fs.readFileSync(path.join(__dirname, 'page.js')), CONTENT_TYPES['.js'])
    }

    if (url.startsWith('/media/')) {
      // Record what the request looked like, so we can prove the header arrived.
      stats.authSeen.push(req.headers.authorization ?? null)
      stats.paths.push(url)
      if (url.endsWith('.m3u8')) stats.playlistHits += 1
      else if (url.endsWith('init.mp4')) stats.initHits += 1
      else stats.segmentHits += 1

      const file = path.join(FIXTURE, path.basename(url))
      if (!fs.existsSync(file)) return send('not found', 'text/plain', 404)
      const ext = path.extname(file)
      return send(fs.readFileSync(file), CONTENT_TYPES[ext] ?? 'application/octet-stream')
    }

    send('not found', 'text/plain', 404)
  })

  /**
   * Stands in for the production media:fetch handler.
   *
   * Deliberately RELAXED relative to production: it accepts http and a
   * localhost host, neither of which MediaFetcher would permit. The point here
   * is the transport, not the allowlist — which has its own tests.
   */
  ipcMain.handle('spike:media-fetch', async (_event, url, range) => {
    const headers = { authorization: SPOOFED_TOKEN }
    if (typeof range === 'string' && range !== '') headers.range = range

    // net.fetch, matching production. Node's global fetch would strip the
    // Authorization header on the redirect — see spikes/net-fetch-redirect.js.
    const response = await session.fromPartition('spike', { cache: false }).fetch(url, {
      headers,
      redirect: 'follow'
    })

    const contentType = response.headers.get('content-type')
    const isPlaylist =
      contentType !== null && (contentType.includes('mpegurl') || contentType.includes('m3u'))
    const finalUrl = response.url === '' ? url : response.url

    if (isPlaylist) {
      return { ok: true, value: { status: response.status, url: finalUrl, contentType, text: await response.text() } }
    }
    const buffer = await response.arrayBuffer()
    return {
      ok: true,
      value: {
        status: response.status,
        url: finalUrl,
        contentType,
        bytes: new Uint8Array(buffer)
      }
    }
  })

  let reported = false
  ipcMain.handle('spike:report', async (_event, payload) => {
    if (reported) return
    reported = true
    report(payload)
    await new Promise((resolve) => server.close(resolve))
    app.quit()
  })

  const win = new BrowserWindow({
    width: 600,
    height: 300,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The harness has no user to click play. Chromium would otherwise block
      // playback as unprompted autoplay.
      autoplayPolicy: 'no-user-gesture-required',
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  win.webContents.on('console-message', (event) => {
    console.log(`  [renderer] ${event.message}`)
  })

  await win.loadURL(`http://127.0.0.1:${port}/page.html`)
  console.log(`\nharness up on :${port} — playing ${PLAY_MS / 1000}s and watching\n`)
})

const report = (payload) => {
  const { currentTime, duration, error, segmentRequests, readyStates } = payload

  console.log('=== result ===')
  if (error) console.log(`  error           : ${error}`)
  console.log(`  currentTime     : ${currentTime?.toFixed(2)}s of ${duration?.toFixed(2)}s`)
  console.log(`  segments served : ${stats.segmentHits} (+${stats.initHits} init)`)
  console.log(`  playlists served: ${stats.playlistHits}`)
  console.log(`  readyStates     : ${readyStates}`)

  const authAllPresent =
    stats.authSeen.length > 0 && stats.authSeen.every((a) => a === SPOOFED_TOKEN)
  console.log(`  auth header     : ${authAllPresent ? 'PRESENT on every request' : `MIXED ${JSON.stringify(stats.authSeen.slice(0, 4))}`}`)

  // 2s segments, so passing 6s means at least three segment boundaries were
  // crossed — segment 1 alone would only prove the first fetch worked.
  const playedPastThreeSegments = typeof currentTime === 'number' && currentTime > 6

  console.log('\n=== verdict ===')
  if (error) {
    console.log('  FAILED — the pipeline errored.')
  } else if (playedPastThreeSegments) {
    console.log('  PASS — audio decoded and played past three segment boundaries,')
    console.log('         through the production loader over IPC.')
  } else {
    console.log(`  INCONCLUSIVE — only reached ${currentTime?.toFixed(2)}s.`)
    console.log('  Segment 1 playing is not enough: it proves one fetch, not that')
    console.log('  relative URI resolution or continued loading works.')
  }

  console.log(`\n  requested paths: ${stats.paths.slice(0, 8).join(', ')}`)
}

void PLAY_MS
