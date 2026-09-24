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

Implemented: project skeleton, IPC bridge with sender validation and `Result`
errors, credential resolution + reporting, non-persistent session setup, shell
allowlist, logging with redaction.

**Not implemented — blocked on credentials.** The streaming path is unproven,
and the plan is deliberately playback-first: prove audio works before building
UI on top of it. The remaining work is:

1. **Spike** — `curl` `/tracks/{urn}/streams` with a token and read the m3u8
   body. The open question is whether playlist/segment URIs need auth or are
   self-sufficient signed CDN URLs. **This decides the entire audio
   architecture.** See the plan at `~/.claude/plans/woolly-cuddling-river.md`
   for the full fallback ladder.
2. **Spike** — what `net.fetch` does with `Authorization` across a cross-origin
   302 (undocumented), and whether `Range`/206 survives.
3. **Spike** — audible playback past the third segment boundary.
4. Then: auth module (PKCE + loopback on `127.0.0.1:8765` + `safeStorage`),
   token lifecycle, player, UI.

Nothing downstream should be built until step 3 passes.
