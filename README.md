# SoundCloud Client

A desktop SoundCloud client for macOS, built with Electron, React, and
TypeScript.

> **Status: early.** The project skeleton runs, but playback and login are not
> implemented yet. See [Current state](#current-state).

## Requirements

- macOS 13 or later (Electron 44's floor)
- Node 24 — installed via `brew install node@24`. It's keg-only, so add
  `/opt/homebrew/opt/node@24/bin` to your PATH.
- **SoundCloud API credentials, which require an Artist Pro subscription.**

## Setup

1. Install dependencies:

   ```bash
   npm install
   node node_modules/electron/install.js   # downloads the Electron binary
   ```

   The second step is not optional. Electron 44 removed its `postinstall`, so
   `npm install` alone leaves you without a runtime.

2. Register an app at [soundcloud.com/you/apps](https://soundcloud.com/you/apps).

3. Set its **redirect URI** to exactly:

   ```
   http://127.0.0.1:8765/callback
   ```

   This must match character for character, including the port. A mismatch is
   the most common cause of a `redirect_uri` error at login. The app displays
   the value it expects on its main screen.

4. Copy `.env.example` to `.env` and fill in your client ID and secret.

5. Run it:

   ```bash
   npm run dev
   ```

## Who can use this

Two audiences, and they need different things:

**Without Artist Pro** — zero setup. The app uses the client ID it was built
with, so you just log in with your free SoundCloud account.

**With Artist Pro** — you can supply your own client ID and secret in settings,
which gives you your own rate-limit quota instead of sharing the built-in one.
(Not implemented yet.)

Artist Pro is required of whoever *registers* the app, not of everyone who uses
it.

## Important limitations

### No offline mode, by design

SoundCloud's API [Terms of Use](https://developers.soundcloud.com/docs/api/terms-of-use)
prohibit it. Not as a gray area — §05 states the app "must not include file-save
functionality, or otherwise designed to cache, download or persistently store
any User Content," and separately bars "temporary downloads for offline
listening" even when the uploader has enabled downloads.

So this client deliberately writes no audio to disk. Playback is buffered in
memory and gone when the app closes. This isn't a missing feature; adding a
download button would violate the terms the app is built on.

For the same reason, the app streams a track only when you press play, credits
the uploader, links back to the original sound, and never autoplays.

### The client secret in a distributed build is not secret

SoundCloud currently treats every client as confidential and requires a
`client_secret` to exchange an authorization code. A desktop app has nowhere
safe to keep one — anything shipped in a binary can be extracted.

That matters because SoundCloud's rate limit is **15,000 stream requests per 24
hours, per client ID**, shared across everyone using that ID. A leaked secret
can be used to exhaust that quota for all your users.

If you distribute this app, treat the built-in secret as public. The
bring-your-own-credentials path exists so users can move to their own quota.

### Not affiliated with SoundCloud

This is an unofficial client. It is not endorsed by or affiliated with
SoundCloud. All content is streamed from SoundCloud and remains the property of
its uploaders.

## Current state

**Working end to end:** sign in, search or paste a link, and play a track.
OAuth 2.1 + PKCE with a loopback callback and a cancellable sign-in, encrypted
token storage, and audio streamed through the main process with credentials
attached — hls.js never holds a token, and nothing is written to disk.

**Not built:** feed, playlists, likes, a queue, and packaging.

**Still unproven:** whether SoundCloud's live API behaves as documented. Every
part of this was built against the published API and tested against synthetic
fixtures — the real service has never been called, because that needs API
credentials, which require an Artist Pro subscription.

That last point is worth weighing before you rely on any of it. The auth flow
and the media pipeline are both verified — against the spec and against a real
HLS stream respectively — but "verified against the documentation" and
"verified against SoundCloud" are different claims, and only the first is true
today.

Two spikes document what was actually measured rather than assumed, and both
changed the design:

- [`spikes/net-fetch-redirect.js`](spikes/net-fetch-redirect.js) — Electron's
  `net.fetch` preserves the `Authorization` header across a cross-origin
  redirect; Node's `fetch` strips it. The media layer depends on this.
- [`spikes/hls-playback/`](spikes/hls-playback/) — drives the real loader
  against a locally generated HLS stream and verifies audio actually plays.

## Development

See [CLAUDE.md](CLAUDE.md) for architecture, the API constraints that shape the
code, and environment gotchas.

```bash
npm run dev        # run with HMR
npm run typecheck  # both tsconfigs
npm run build      # typecheck + build
```
