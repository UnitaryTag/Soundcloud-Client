import type { AuthStatus } from '@shared/sc'
import { builtinCredentials } from './env'
import { MediaFetcher } from './media/fetch-media'
import { mediaSession } from './media/session'
import { ApiClient, getMe } from './soundcloud/api'
import { AuthService } from './soundcloud/auth'
import { DEFAULT_PORT } from './soundcloud/loopback'
import { exchangeRefreshToken, type Credentials } from './soundcloud/oauth'
import { createTokenStore } from './soundcloud/token-store'
import { NotSignedIn, RefreshRejected, TokenManager } from './soundcloud/tokens'

/**
 * The object graph, built once at startup.
 *
 * Kept out of index.ts so the lifecycle file stays about lifecycle. Credentials
 * are resolved through closures rather than captured values so that a settings
 * screen can swap them at runtime without rebuilding any of this.
 */

export type Services = {
  credentials: () => Credentials | null
  tokens: TokenManager
  api: ApiClient
  auth: AuthService
  media: MediaFetcher
}

export const createServices = (options: {
  openExternal: (url: string) => Promise<void>
  onAuthChanged: (status: AuthStatus) => void
}): Services => {
  const configured = builtinCredentials()

  const credentials = (): Credentials | null =>
    configured === null
      ? null
      : { clientId: configured.clientId, clientSecret: configured.clientSecret }

  const tokens = new TokenManager({
    store: createTokenStore(),
    exchange: async (refreshToken) => {
      const current = credentials()
      if (current === null) {
        // RefreshRejected rather than a generic error: without credentials the
        // refresh token can never be redeemed, so the session is genuinely over
        // and the UI should say so instead of offering a retry.
        throw new RefreshRejected('No SoundCloud credentials are configured.')
      }
      return exchangeRefreshToken(refreshToken, current)
    }
  })

  const api = new ApiClient({
    getAccessToken: async () => {
      const current = credentials()
      if (current === null) throw new NotSignedIn('No SoundCloud credentials are configured.')
      return tokens.getAccessToken(current.clientId)
    },
    invalidateAccessToken: () => tokens.invalidate()
  })

  const auth = new AuthService({
    getCredentials: credentials,
    redirectPort: () => configured?.redirectPort ?? DEFAULT_PORT,
    openExternal: options.openExternal,
    fetchCurrentUser: () => getMe(api),
    tokens,
    onChanged: options.onAuthChanged
  })

  const media = new MediaFetcher({
    // The session partition is resolved lazily because `session.fromPartition`
    // needs the app to be ready, and this graph is constructed before that in
    // some paths.
    fetch: (url, init) => mediaSession().fetch(url, init),
    getAccessToken: async () => {
      const current = credentials()
      if (current === null) throw new NotSignedIn('No SoundCloud credentials are configured.')
      return tokens.getAccessToken(current.clientId)
    }
  })

  return { credentials, tokens, api, auth, media }
}
