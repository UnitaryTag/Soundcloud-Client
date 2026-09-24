/**
 * Every IPC handler returns a Result rather than throwing.
 *
 * An error thrown inside `ipcMain.handle` is serialized across the process
 * boundary and only `message` survives — no stack, no custom properties. So
 * structured errors have to be values.
 */

export const AppErrorCode = {
  // --- auth ---
  AuthDenied: 'AUTH_DENIED',
  AuthTimeout: 'AUTH_TIMEOUT',
  AuthInProgress: 'AUTH_IN_PROGRESS',
  TokenStoreUnreadable: 'TOKEN_STORE_UNREADABLE',
  NotSignedIn: 'NOT_SIGNED_IN',

  // --- credentials ---
  NoCredentials: 'NO_CREDENTIALS',

  // --- caller error ---
  /** The request was malformed or rejected by input validation. Not a fault of the API or the session. */
  InvalidRequest: 'INVALID_REQUEST',

  // --- api ---
  RateLimited: 'RATE_LIMITED',
  Unauthorized: 'UNAUTHORIZED',
  NotFound: 'NOT_FOUND',
  NetworkError: 'NETWORK_ERROR',

  // --- media ---
  StreamUnavailable: 'STREAM_UNAVAILABLE',

  Unknown: 'UNKNOWN'
} as const

export type AppErrorCode = (typeof AppErrorCode)[keyof typeof AppErrorCode]

export type AppError = {
  code: AppErrorCode
  message: string
  /** Epoch ms. Only set for RateLimited — SoundCloud's 429 body carries reset_time. */
  resetAt?: number
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError }

export const ok = <T>(value: T): Result<T> => ({ ok: true, value })

export const err = <T = never>(
  code: AppErrorCode,
  message: string,
  resetAt?: number
): Result<T> => ({
  ok: false,
  error: resetAt === undefined ? { code, message } : { code, message, resetAt }
})
