/**
 * The SIWC OAuth conversation: PKCE/state/nonce, the authorization URL, the
 * loopback callback listener, token exchange, refresh, revocation, and ID
 * token validation. Signature checks use `jose`; no cryptography is
 * hand-rolled beyond calling node:crypto primitives for randomness and SHA-256.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose'
import { attributionHeaders } from '@deepseek-ai/dsh-llm'
import {
  AGENT_NAME_HINT,
  CALLBACK_PATH,
  DYNAMIC_CLIENT_ID,
  LOOPBACK_HOST,
  PLAN_USAGE_SCOPE,
  RESOURCE,
  SCOPES,
  TERMINAL_REFRESH_ERRORS,
  type SiwcEndpoints,
} from './protocol.ts'
import { requestIdOf } from './errors.ts'
import { redact } from './redact.ts'
import { isPositiveFinite } from './store.ts'

/** A protocol failure with a stable code; messages never carry token material. */
export class SiwcAuthError extends Error {
  constructor(
    message: string,
    /** OAuth `error` value or a local code such as `state_mismatch`. */
    readonly code: string,
    /** HTTP status when the failure came from an endpoint. */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'SiwcAuthError'
  }

  /** Whether the stored refresh token can never succeed again. */
  get terminal(): boolean {
    return TERMINAL_REFRESH_ERRORS.has(this.code)
  }
}

// ---------------------------------------------------------------- attempt

export interface AuthorizationAttempt {
  state: string
  nonce: string
  verifier: string
  challenge: string
}

const base64url = (bytes: Buffer) => bytes.toString('base64url')

export function createAttempt(): AuthorizationAttempt {
  const verifier = base64url(randomBytes(32))
  return {
    state: base64url(randomBytes(32)),
    nonce: base64url(randomBytes(32)),
    verifier,
    challenge: pkceChallenge(verifier),
  }
}

/** RFC 7636 S256: base64url(SHA-256(verifier)) without padding. */
export function pkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest())
}

/** Constant-time comparison of two strings; differing lengths are unequal. */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

export interface AuthorizeParams {
  /** Issued client id for a returning account; omit for first registration. */
  clientId?: string
  hostId: string
  redirectUri: string
  attempt: AuthorizationAttempt
  /** Saved email of a returning account. */
  loginHint?: string
  /** `consent` only when the user explicitly re-enables plan usage. */
  prompt?: 'consent'
}

export function buildAuthorizeUrl(endpoints: SiwcEndpoints, p: AuthorizeParams): string {
  const url = new URL(endpoints.authorize)
  const q = url.searchParams
  q.set('client_id', p.clientId ?? DYNAMIC_CLIENT_ID)
  if (!p.clientId) q.set('agent_name_hint', AGENT_NAME_HINT)
  q.set('ext_agent_host_id', p.hostId)
  if (p.clientId && p.loginHint) q.set('login_hint', p.loginHint)
  q.set('response_type', 'code')
  q.set('redirect_uri', p.redirectUri)
  q.set('scope', SCOPES.join(' '))
  q.set('resource', RESOURCE)
  q.set('state', p.attempt.state)
  q.set('nonce', p.attempt.nonce)
  q.set('code_challenge_method', 'S256')
  q.set('code_challenge', p.attempt.challenge)
  if (p.prompt) q.set('prompt', p.prompt)
  return url.toString()
}

// ---------------------------------------------------------------- callback

export interface CallbackListener {
  /** Exact redirect URI for this attempt, including the OS-assigned port. */
  redirectUri: string
  /** Resolves with the query of the first callback whose `state` matches. */
  result: Promise<URLSearchParams>
  close(): void
}

const CALLBACK_DONE_PAGE =
  '<!doctype html><meta charset="utf-8"><title>DSH OpenAI SIWC</title>' +
  '<p>Sign-in finished. You can close this window and return to DeepSeek Harness.</p>'

/**
 * Listen on 127.0.0.1 for exactly one valid callback. Requests with a wrong
 * path, method, Host header, or state are refused and the listener keeps
 * waiting, so a forged request cannot end the real attempt.
 * @param expectedState - the state sent in the authorization request.
 * @param signal - aborts the wait and closes the listener.
 * @param timeoutMs - upper bound on how long the browser round trip may take.
 */
export async function listenForCallback(
  expectedState: string,
  signal: AbortSignal,
  timeoutMs = 10 * 60_000,
): Promise<CallbackListener> {
  let settle!: { resolve: (q: URLSearchParams) => void; reject: (e: unknown) => void }
  const result = new Promise<URLSearchParams>((resolve, reject) => (settle = { resolve, reject }))
  result.catch(() => {})

  let port = 0
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, body: string) => {
      res.writeHead(status, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff',
      })
      res.end(body)
    }
    if (req.method !== 'GET') return reply(405, 'Method not allowed')
    if (req.headers.host !== `${LOOPBACK_HOST}:${port}`) return reply(400, 'Bad request')
    const url = new URL(req.url ?? '/', `http://${LOOPBACK_HOST}:${port}`)
    if (url.pathname !== CALLBACK_PATH) return reply(404, 'Not found')
    const state = url.searchParams.get('state')
    if (!state || !safeEqual(state, expectedState)) return reply(400, 'Invalid sign-in callback')
    reply(200, CALLBACK_DONE_PAGE)
    close()
    settle.resolve(url.searchParams)
  })

  const timer = setTimeout(() => {
    close()
    settle.reject(new SiwcAuthError('Timed out waiting for the browser sign-in to finish', 'callback_timeout'))
  }, timeoutMs)
  timer.unref()
  const onAbort = () => {
    close()
    settle.reject(signal.reason ?? new SiwcAuthError('Sign-in cancelled', 'cancelled'))
  }
  function close() {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    server.close()
    server.closeAllConnections()
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, LOOPBACK_HOST, () => resolve())
  })
  port = (server.address() as AddressInfo).port
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })

  return { redirectUri: `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`, result, close }
}

export interface CallbackOutcome {
  code: string
  /** The client id the token exchange must use. */
  clientId: string
}

/**
 * Validate a callback query whose state already matched.
 * @param query - callback query parameters.
 * @param pendingClientId - issued client id of a reauthorization, if any.
 */
export function readCallback(query: URLSearchParams, pendingClientId: string | undefined): CallbackOutcome {
  const error = query.get('error')
  if (error) {
    throw new SiwcAuthError(
      error === 'access_denied'
        ? 'ChatGPT sign-in or plan usage was declined in the browser. ' +
          'Sign in again and allow ChatGPT plan usage, or choose another provider such as your own API key.'
        : `ChatGPT sign-in failed (${redact(error)})`,
      error,
    )
  }
  const code = query.get('code')
  if (!code) throw new SiwcAuthError('Sign-in callback carried no authorization code', 'missing_code')
  const returned = query.get('client_id') ?? undefined
  if (pendingClientId) {
    if (returned && returned !== pendingClientId) {
      throw new SiwcAuthError('Sign-in callback returned a different client id than this account uses', 'client_mismatch')
    }
    return { code, clientId: pendingClientId }
  }
  if (!returned || returned === DYNAMIC_CLIENT_ID) {
    throw new SiwcAuthError('Registration incomplete: the callback did not return an issued client id', 'registration_incomplete')
  }
  return { code, clientId: returned }
}

// ---------------------------------------------------------------- token endpoint

export interface TokenResponse {
  accessToken: string
  refreshToken?: string
  idToken?: string
  expiresIn: number
  scopes: string[]
  earliestRefreshAt?: number
}

/** `earliest_refresh_at` is undocumented in format; accept epoch s/ms or a date string, else ignore. */
export function parseEarliestRefreshAt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value < 1e12 ? value * 1000 : value
  if (typeof value === 'string') {
    const t = Date.parse(value)
    return Number.isFinite(t) ? t : undefined
  }
  return undefined
}

async function postForm(url: string, body: Record<string, string>, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetch(url, {
      method: 'POST',
      headers: { ...attributionHeaders(), 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams(body),
      signal,
      redirect: 'error',
    })
  } catch (cause) {
    if (signal?.aborted) throw cause
    throw new SiwcAuthError(`Could not reach the OpenAI auth server (${redact(String(cause))})`, 'network')
  }
}

async function tokenRequest(endpoints: SiwcEndpoints, body: Record<string, string>, signal?: AbortSignal): Promise<TokenResponse> {
  const res = await postForm(endpoints.token, body, signal)
  const text = await res.text()
  let json: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) json = parsed as Record<string, unknown>
  } catch {}
  if (!res.ok) {
    const code = typeof json?.error === 'string' ? json.error : `http_${res.status}`
    const description = typeof json?.error_description === 'string' ? `: ${redact(json.error_description)}` : ''
    const requestId = requestIdOf(res.headers)
    throw new SiwcAuthError(
      `OpenAI token endpoint refused the request: ${redact(code)}${description} (HTTP ${res.status}` +
        `${requestId ? `, request id ${redact(requestId)}` : ''})`,
      code,
      res.status,
    )
  }
  // expires_in must be a positive finite lifetime (JSON.parse("1e999") is Infinity).
  if (!json || typeof json.access_token !== 'string' || !isPositiveFinite(json.expires_in)) {
    // A 200 that is not a token response is a transport/server problem, not a revoked grant.
    throw new SiwcAuthError('OpenAI token endpoint returned an unexpected response', 'malformed_token_response', res.status)
  }
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : undefined,
    idToken: typeof json.id_token === 'string' ? json.id_token : undefined,
    expiresIn: json.expires_in,
    scopes: typeof json.scope === 'string' ? json.scope.split(' ').filter(Boolean) : [],
    earliestRefreshAt: parseEarliestRefreshAt(json.earliest_refresh_at),
  }
}

export function exchangeCode(
  endpoints: SiwcEndpoints,
  p: { clientId: string; code: string; verifier: string; redirectUri: string },
  signal?: AbortSignal,
): Promise<TokenResponse> {
  return tokenRequest(endpoints, {
    grant_type: 'authorization_code',
    client_id: p.clientId,
    code: p.code,
    code_verifier: p.verifier,
    redirect_uri: p.redirectUri,
    resource: RESOURCE,
  }, signal)
}

/** Refresh without `scope`, which keeps the existing grant. */
export function refreshTokens(
  endpoints: SiwcEndpoints,
  p: { clientId: string; refreshToken: string },
  signal?: AbortSignal,
): Promise<TokenResponse> {
  return tokenRequest(endpoints, {
    grant_type: 'refresh_token',
    client_id: p.clientId,
    refresh_token: p.refreshToken,
    resource: RESOURCE,
  }, signal)
}

/**
 * Revoke the renewable session. Retries network failures and 5xx with backoff.
 * @returns true when the server confirmed revocation (HTTP 200).
 */
export async function revokeRefreshToken(
  endpoints: SiwcEndpoints,
  p: { clientId: string; refreshToken: string },
  attempts = 3,
  baseDelayMs = 500,
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** (i - 1)))
    try {
      const res = await postForm(endpoints.revoke, {
        token: p.refreshToken,
        token_type_hint: 'refresh_token',
        client_id: p.clientId,
      })
      await res.body?.cancel()
      if (res.status === 200) return true
      if (res.status < 500) return false
    } catch {}
  }
  return false
}

// ---------------------------------------------------------------- ID token

export interface VerifiedIdentity {
  subject: string
  email?: string
}

const jwksCache = new Map<string, JWTVerifyGetKey>()

function jwksFor(url: string): JWTVerifyGetKey {
  let set = jwksCache.get(url)
  if (!set) jwksCache.set(url, (set = createRemoteJWKSet(new URL(url))))
  return set
}

/**
 * Verify signature (RS256 against the published JWKS), issuer, audience,
 * expiry, and — for an authorization-code response — the attempt's nonce.
 */
export async function verifyIdToken(
  endpoints: SiwcEndpoints,
  idToken: string,
  expected: { clientId: string; nonce?: string },
): Promise<VerifiedIdentity> {
  let payload
  try {
    ;({ payload } = await jwtVerify(idToken, jwksFor(endpoints.jwks), {
      issuer: endpoints.issuer,
      audience: expected.clientId,
      algorithms: ['RS256'],
    }))
  } catch (cause) {
    const code = (cause as { code?: string }).code ?? 'invalid_id_token'
    throw new SiwcAuthError(`ID token failed validation (${code})`, 'invalid_id_token')
  }
  if (expected.nonce !== undefined && (typeof payload.nonce !== 'string' || !safeEqual(payload.nonce, expected.nonce))) {
    throw new SiwcAuthError('ID token failed validation (nonce mismatch)', 'invalid_id_token')
  }
  if (typeof payload.sub !== 'string' || !payload.sub) {
    throw new SiwcAuthError('ID token failed validation (missing subject)', 'invalid_id_token')
  }
  return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined }
}

export const hasPlanUsage = (scopes: readonly string[]) => scopes.includes(PLAN_USAGE_SCOPE)
