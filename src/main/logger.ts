/**
 * Logging with redaction.
 *
 * The OAuth loopback callback URL carries the authorization code in its query
 * string, and Authorization headers carry the bearer token. Neither should ever
 * reach a terminal, a log file, or a crash report.
 */

const TOKEN_RE = /\b(OAuth|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi
const QUERY_RE = /\?[^\s"'`)]+/

export const redact = (value: string): string =>
  value.replace(TOKEN_RE, '$1 [redacted]').replace(QUERY_RE, '?[redacted]')

const render = (arg: unknown): unknown =>
  typeof arg === 'string' ? redact(arg) : arg instanceof Error ? redact(arg.message) : arg

export const log = {
  info: (...args: unknown[]): void => console.log('[sc]', ...args.map(render)),
  warn: (...args: unknown[]): void => console.warn('[sc]', ...args.map(render)),
  error: (...args: unknown[]): void => console.error('[sc]', ...args.map(render))
}
