/**
 * Token lifecycle for the signed-in account: completing a sign-in, handing
 * out a fresh access token (refreshing under the credential seam's exclusive
 * write so concurrent processes never race a rotating refresh token), and
 * signing out with remote revocation.
 */
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Logger } from '@deepseek-ai/cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import {
  SiwcAuthError,
  hasPlanUsage,
  refreshTokens,
  revokeRefreshToken,
  verifyIdToken,
  type TokenResponse,
} from './oauth.ts'
import { PLAN_USAGE_SCOPE, type SiwcEndpoints } from './protocol.ts'
import { SIGN_IN_HINT } from './errors.ts'
import { REGISTRY_KEY, SESSION_KEY, parseRegistry, parseSession, toRecord, type Registry, type SessionTokens } from './store.ts'

/** Refresh this long before expiry so an in-flight request never carries a stale token. */
export const REFRESH_SKEW_MS = 60_000

export function sessionFromTokens(
  tokens: TokenResponse,
  identity: { clientId: string; subject: string; email?: string; idToken: string },
  now = Date.now(),
): SessionTokens {
  return {
    version: 1,
    clientId: identity.clientId,
    subject: identity.subject,
    email: identity.email,
    idToken: identity.idToken,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: now + tokens.expiresIn * 1000,
    earliestRefreshAt: tokens.earliestRefreshAt,
    scopes: tokens.scopes,
    savedAt: new Date(now).toISOString(),
  }
}

export function needsRefresh(s: SessionTokens, now = Date.now()): boolean {
  if (s.expiresAt - REFRESH_SKEW_MS > now) return false
  // Expired tokens are always refreshed; the hint only defers early refresh.
  return s.expiresAt <= now || s.earliestRefreshAt === undefined || s.earliestRefreshAt <= now
}

export interface SignOutResult {
  /** False when no session existed. */
  hadSession: boolean
  /** Whether the server confirmed revocation of the refresh token. */
  revoked: boolean
}

export class SiwcSession {
  constructor(
    private readonly credentials: () => CredentialProvider,
    private readonly endpoints: SiwcEndpoints,
    private readonly logger: Logger,
  ) {}

  async current(): Promise<SessionTokens | undefined> {
    return parseSession(await this.credentials().readRecord(SESSION_KEY))
  }

  /** Host id, saved registrations and the last sign-in failure (no secrets). */
  async registry(): Promise<Registry | undefined> {
    return parseRegistry(await this.credentials().readRecord(REGISTRY_KEY))
  }

  /**
   * A usable access token for an inference request, refreshing if needed.
   * @throws LlmError `MISSING_CREDENTIAL`, `SIWC_PLAN_USAGE_DISABLED`, `AUTH`, or `TRANSPORT`.
   */
  async accessToken(signal?: AbortSignal): Promise<string> {
    let session = await this.current()
    if (!session) throw new LlmError(`Not signed in to ChatGPT. ${SIGN_IN_HINT}`, 'MISSING_CREDENTIAL')
    if (!hasPlanUsage(session.scopes)) {
      throw new LlmError(
        `ChatGPT plan usage is not enabled for this sign-in (scope ${PLAN_USAGE_SCOPE} was not granted). ` +
          'Sign in again and allow plan usage, or use another provider.',
        'SIWC_PLAN_USAGE_DISABLED',
      )
    }
    if (needsRefresh(session)) session = await this.refresh(signal)
    return session.accessToken
  }

  /** Refresh under exclusive write; a peer process that already refreshed wins. */
  async refresh(signal?: AbortSignal): Promise<SessionTokens> {
    let latest: SessionTokens | undefined
    let terminal: SiwcAuthError | undefined
    try {
      await this.credentials().modifyRecord(SESSION_KEY, async (record) => {
        const stored = parseSession(record)
        if (!stored) return undefined
        if (!needsRefresh(stored)) {
          latest = stored
          return undefined
        }
        if (!stored.refreshToken) {
          terminal = new SiwcAuthError('No refresh token stored', 'invalid_grant')
          return undefined
        }
        let tokens: TokenResponse
        try {
          tokens = await refreshTokens(this.endpoints, { clientId: stored.clientId, refreshToken: stored.refreshToken }, signal)
        } catch (error) {
          if (error instanceof SiwcAuthError && error.terminal) {
            terminal = error
            return undefined
          }
          throw error
        }
        let idToken = stored.idToken
        if (tokens.idToken) {
          const identity = await verifyIdToken(this.endpoints, tokens.idToken, { clientId: stored.clientId })
          if (identity.subject !== stored.subject) {
            throw new SiwcAuthError('Refreshed ID token belongs to a different account', 'subject_mismatch')
          }
          idToken = tokens.idToken
        }
        latest = sessionFromTokens(
          // Keep the previous refresh token only if the server did not rotate it.
          { ...tokens, refreshToken: tokens.refreshToken ?? stored.refreshToken, scopes: tokens.scopes.length ? tokens.scopes : stored.scopes },
          { clientId: stored.clientId, subject: stored.subject, email: stored.email, idToken },
        )
        return toRecord(latest)
      })
    } catch (error) {
      if (signal?.aborted) throw error
      const code = error instanceof SiwcAuthError ? error.code : 'unknown'
      const status = error instanceof SiwcAuthError ? error.status : undefined
      this.logger.warn('token refresh failed (%s); credentials kept', code)
      const transient = code === 'network' || code === 'malformed_token_response' || status === 429 || (status ?? 0) >= 500
      throw new LlmError(
        transient
          ? `Could not refresh the ChatGPT access token (${code}); credentials were kept, retry later.`
          : `ChatGPT token refresh was refused (${code}); credentials were kept. ${SIGN_IN_HINT}`,
        transient ? 'TRANSPORT' : 'AUTH',
        { status },
      )
    }
    if (terminal) {
      // The grant is gone for good: drop the unusable tokens; the registry keeps the client id.
      await this.credentials().deleteRecord(SESSION_KEY)
      this.logger.info('refresh token rejected (%s); signed out locally', terminal.code)
      throw new LlmError(`ChatGPT session ended (${terminal.code}). ${SIGN_IN_HINT}`, 'AUTH', { status: terminal.status })
    }
    if (!latest) throw new LlmError(`Not signed in to ChatGPT. ${SIGN_IN_HINT}`, 'MISSING_CREDENTIAL')
    if (!hasPlanUsage(latest.scopes)) {
      throw new LlmError('ChatGPT plan usage permission is no longer granted.', 'SIWC_PLAN_USAGE_DISABLED')
    }
    return latest
  }

  /** Stop using the session: revoke remotely, then clear tokens locally. */
  async signOut(): Promise<SignOutResult> {
    const session = await this.current()
    if (!session) {
      await this.credentials().deleteRecord(SESSION_KEY)
      return { hadSession: false, revoked: false }
    }
    const revoked = session.refreshToken
      ? await revokeRefreshToken(this.endpoints, { clientId: session.clientId, refreshToken: session.refreshToken })
      : false
    await this.credentials().deleteRecord(SESSION_KEY)
    return { hadSession: true, revoked }
  }
}
