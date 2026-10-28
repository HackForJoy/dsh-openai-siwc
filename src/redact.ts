/**
 * Last-line scrubbing for any text that may reach a log, an error message, or
 * a diagnostic. Callers still never pass tokens on purpose; this catches what
 * a provider or transport echoes back.
 */

const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi
const SECRET_PARAM =
  /\b(access_token|refresh_token|id_token|id_token_hint|code|code_verifier|token|state|nonce)=([^&\s"']+)/gi
const SECRET_FIELD =
  /("(?:access_token|refresh_token|id_token|accessToken|refreshToken|idToken|code_verifier|authorization)"\s*:\s*")([^"]*)(")/gi

const MAX_LENGTH = 500

/**
 * Remove token-shaped values and secret query/JSON fields, then bound length.
 * @param text - untrusted text such as a provider error body.
 * @returns text safe to show in diagnostics.
 */
export function redact(text: string): string {
  const scrubbed = text
    .replace(JWT, '[redacted-jwt]')
    .replace(BEARER, '$1 [redacted]')
    .replace(SECRET_PARAM, '$1=[redacted]')
    .replace(SECRET_FIELD, '$1[redacted]$3')
  return scrubbed.length > MAX_LENGTH ? `${scrubbed.slice(0, MAX_LENGTH)}…` : scrubbed
}
