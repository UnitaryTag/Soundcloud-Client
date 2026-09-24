import { AppErrorCode, err, ok, type Result } from '@shared/result'
import { log } from '../logger'
import { ApiError } from '../soundcloud/api'
import { TokenRequestFailed } from '../soundcloud/oauth'
import { NotSignedIn, RefreshRejected } from '../soundcloud/tokens'

/**
 * Translate domain errors into the `Result` values that cross IPC.
 *
 * Centralised because the mapping is a policy decision, not a per-handler one:
 * a dead session and a dropped connection both need to look different to the
 * UI, and scattering that logic guarantees it drifts.
 *
 * Genuinely unexpected errors are rethrown, so `handle()` logs them and
 * converts them — no silent swallowing.
 */
export const toResult = async <T>(fn: () => Promise<T>): Promise<Result<T>> => {
  try {
    return ok(await fn())
  } catch (cause) {
    if (cause instanceof ApiError) {
      // `?? undefined` because RateLimitInfo models "server didn't say" as null,
      // while AppError models it as an absent field.
      return err<T>(cause.code, cause.message, cause.rateLimit?.resetAt ?? undefined)
    }
    // The session is gone, whatever the surface reason — the UI should offer a
    // sign-in rather than a retry.
    if (cause instanceof NotSignedIn || cause instanceof RefreshRejected) {
      return err<T>(AppErrorCode.NotSignedIn, cause.message)
    }
    // Our request never completed, so the caller should be able to try again.
    if (cause instanceof TokenRequestFailed) {
      return err<T>(AppErrorCode.NetworkError, cause.message)
    }

    log.error('unhandled error in an IPC handler:', cause)
    throw cause
  }
}
