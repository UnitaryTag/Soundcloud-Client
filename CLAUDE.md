# SoundCloud Desktop Client

Electron + React + TypeScript desktop client for SoundCloud. Built for two
audiences: users with a free SoundCloud account (zero setup, app supplies the
`client_id`) and users with Artist Pro (can supply their own credentials for
their own rate-limit quota).

## Commands

```bash
npm run dev         # electron-vite dev, HMR
npm run build       # typecheck + build all three targets to out/
npm run typecheck   # both tsconfigs
```

Node 24 is required and is **keg-only**: `/opt/homebrew/opt/node@24/bin` must be
on PATH. If your shell can't find `node`, that's why.

## Environment gotchas

**`ELECTRON_RUN_AS_NODE=1` breaks everything.** VS Code sets this for child
processes. When present, Electron runs as plain Node — `require('electron')`
returns a path string instead of the API, and the app dies with
`Cannot read properties of undefined (reading 'whenReady')`. Launch with the
variable cleared:

```bash
env -u ELECTRON_RUN_AS_NODE npm run dev
```

Symptom to recognise: `electron --version` prints a Node version (`v24.21.0`)
instead of an Electron one (`v44.4.5`).

**Electron 44 has no `postinstall`.** Its package.json has no `scripts` field at
all; the binary download is an explicit opt-in binary, `install-electron`
(`node node_modules/electron/install.js`). A fresh `npm install` leaves
`node_modules/electron/dist/` empty and `path.txt` missing until you run it.

## Architecture

**Main holds everything privileged.** All tokens, the `client_secret`, all
authenticated network calls, and all filesystem access. The renderer holds *no*
token, secret, or client id — everything it knows arrives as copied-and-frozen
plain data over IPC.

**Preload is a thin bundled bridge.** `ipcRenderer` is never exposed (it can't
cross `contextBridge` as of Electron 29 anyway). Individual channels are wrapped.

**`sandbox: true` requires a CommonJS preload.** This is why `package.json` has
no `"type": "module"` — ESM preloads cannot be sandboxed. Dropping ESM output
was a deliberate trade to keep the sandbox. The renderer is still bundled as ESM
by Vite; that's unaffected.

**All IPC goes through `handle()` in [register.ts](src/main/ipc/register.ts)** —
the only place `ipcMain.handle` is called. It adds sender validation and
converts thrown errors to `Result` values, because only `message` survives IPC
error serialization (no stack, no custom properties).

**TypeScript is split three ways** — root (references only), `tsconfig.node.json`
(main + preload, Node types, **no DOM**), `tsconfig.web.json` (renderer, DOM +
JSX). DOM types in the node config produce false negatives: code that
typechecks and then crashes at runtime. Path aliases are declared in **two**
places that must stay in sync — the tsconfigs and `electron.vite.config.ts`.

## SoundCloud API constraints

These are non-obvious and expensive to rediscover.

- **The auth header is `Authorization: OAuth <token>`** — literally `OAuth`, not
  `Bearer`. A `Bearer` anywhere in this codebase is a bug.
- **URNs are the primary key**: `soundcloud:tracks:123456`. Numeric `id` was
  deprecated 2025-04. Never key a map by it; never parse the numeric part out.
- **Refresh tokens are single-use.** Every refresh returns a new one, so
  concurrent refreshes can burn the session. Refresh must be single-flight
  (one shared in-flight promise).
- **Stream URLs need auth on the request itself.** `GET /tracks/{urn}/streams`
  (plural — singular `/stream` isn't in the spec) returns URLs that 401 if used
  directly as an `<audio>` src. They must be fetched with the auth header and
  followed through a 302 to a signed CDN URL. Progressive MP3 was removed in
  Aug 2026; it's HLS/AAC only.
- **Rate limit is per `client_id`** — 15k streams / 24h, shared across *all*
  users of a given client id. There are no `X-RateLimit-*` headers; a 429 carries
  a JSON body with `errors[].meta.rate_limit`.
- **Credentials require Artist Pro.** Registration is self-serve but gated.
- `/me/activities` is deprecated — use `/me/feed`.

## Media pipeline

Measured by `spikes/net-fetch-redirect.js` and `spikes/hls-playback/`, not
reasoned about. Re-run them if any of this is in doubt.

- **`Authorization` survives a cross-origin 302 in Electron's `net.fetch`, but
  is stripped by Node's global `fetch`.** SoundCloud's stream URLs redirect to a
  signed CDN host, so media MUST go through `net.fetch`. Using Node's fetch
  would 401 every segment with no visible cause. (OAuth uses Node's fetch
  deliberately — no redirects there, and it keeps the token exchange outside
  Chromium entirely.)
- **`redirect: 'manual'` does not work with `net.fetch`** — it fails with
  "Redirect was cancelled". Following redirects by hand is therefore not
  available, which makes the host allowlist the *only* thing between the user's
  token and an arbitrary host. It is enforced on every request.
- **hls.js reads the playlist body from `LoaderResponse.data`, not `.text`.**
  Setting only `text` throws "cannot read properties of undefined" deep inside
  `parseMasterPlaylist`. `IpcLoader` sets both.
- **The renderer CSP needs `worker-src blob:`.** Without it hls.js's transmuxer
  worker is blocked and it silently falls back to the main thread — playback
  still works, but competes with the UI.
- **Media types are case-insensitive.** `application/x-mpegURL` is a real
  spelling; a case-sensitive check classifies playlists as binary segments.
- **The `Loader` interface requires `stats` and a *public* `context`.** A
  private field cannot satisfy a public interface member.

### Why media URLs, not opaque handles

hls.js resolves segment URIs against the playlist's response URL, so children
must be addressable by URL no matter what. Handles would cover only the first
request while adding a layer to keep in sync, so the **host allowlist is the
boundary** instead — https only, suffix-matched so `sndcdn.com.evil.test` fails.

### Proving playback without credentials

`spikes/hls-playback/` bundles the **production** `IpcLoader` with esbuild (not a
copy) and drives it against an ffmpeg-generated AAC/fMP4 fixture served locally.
It passes: audio decodes and plays past three segment boundaries, with the auth
header on every request. That covers the transport. It does **not** cover
SoundCloud's actual URLs, auth, or playlist shape.

Regenerate the fixture with:
```bash
ffmpeg -y -f lavfi -i "sine=frequency=440:duration=20" -c:a aac -b:a 160k \
  -f hls -hls_time 2 -hls_playlist_type vod -hls_segment_type fmp4 \
  -hls_fmp4_init_filename init.mp4 /tmp/sc-fixture/stream.m3u8
```

## Terms of Use constraints (non-negotiable)

These shape the code, not just the docs.

- **§05 — no persistent storage of User Content.** No downloads, no offline
  mode, nothing on disk. Session caching is permitted only if it "cease[s] to be
  available, accessible or playable" at session end. Enforced by three
  mechanisms, all in [media/session.ts](src/main/media/session.ts): a
  `{cache: false}` partition for media fetches, `Cache-Control: no-store` on
  proxied responses, and a **non-persistent** renderer partition. Note that plain
  `net.fetch` uses the *default* session, which **has** a disk cache — always go
  through `mediaSession().fetch(...)`.
- **§08 — attribution is required.** Apps that stream User Content must credit
  the uploader, credit SoundCloud, and backlink to the sound's page. This is a
  UI requirement, not a nicety.
- **§03 — no SoundCloud Go content.**
- **§04 — all playback must be user-initiated.** No autoplay anywhere.

## Credential model

Resolution order is **user-supplied → built-in → none**. The built-in half reads
`SC_CLIENT_ID` / `SC_CLIENT_SECRET` from `.env` (gitignored) or `process.env`
(which wins). The user-supplied half is not implemented yet; it will be stored
via `safeStorage` in `creds.bin`.

**`client_secret` is optional in the type on purpose.** SoundCloud currently
treats all clients as confidential and requires it, but if they ever mark an app
public the code must omit the parameter entirely rather than send an empty
string.

**Anything built into the bundle is extractable.** Serving zero-setup free users
requires shipping the secret, so treat it as public when distributing. The
user-supplied path is the mitigation.

## Current state

**Built and tested (158 tests):**

- Project skeleton, IPC bridge with sender validation, `Result` errors
- Credential resolution and reporting, `safeStorage`-encrypted token store
- **Auth** — PKCE (verified against the RFC 7636 vector), loopback callback
  server, single-flight refresh, OAuth exchange, URN-based API client
- **Media** — authenticated fetch with host allowlist, `IpcLoader` for hls.js,
  playback verified end to end against a local fixture
- Renderer: login and browse views, wired through IPC

**Not built:** track → stream resolution (`streams.ts` and the `media:resolve`
channel), the player UI, and `mediaSession`. The pieces exist; the wiring
between "a track was chosen" and "hls.js loads a stream URL" does not.

**Still unverified — needs an Artist Pro app (~$99/yr), not yet obtained:**
whether SoundCloud's live API matches the documented shapes, and whether its
real stream URLs behave like the local fixture. Everything above was built
against documentation and a synthetic stream.

**On sequencing.** Spike 1's answer — whether segments need per-request auth —
turned out not to matter for the architecture: routing every request through
the authenticated main process works either way, and only decides whether a
*simpler* design is available. Building ahead of it was the right call.

The lesson worth keeping: the two spikes each **changed the design** rather
than confirming it. The redirect finding ruled out the planned fallback;
the playback harness found three bugs that no amount of reasoning would have
surfaced. Spikes are cheap; assuming is not.
