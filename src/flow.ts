/**
 * The "Continue with ChatGPT" authorization flow registered with
 * `ctx.authorization`. One run = one authorization attempt with fresh state,
 * nonce and PKCE; the session record is committed only after the callback,
 * code exchange, ID token, and account identity all validate.
 */
import type { AuthorizationFlow, AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Logger } from '@deepseek-ai/cordis'
import {
  SiwcAuthError,
  buildAuthorizeUrl,
  createAttempt,
  exchangeCode,
  hasPlanUsage,
  listenForCallback,
  readCallback,
  revokeRefreshToken,
  verifyIdToken,
} from './oauth.ts'
import { PLAN_USAGE_SCOPE, USAGE_SETTINGS_URL, type SiwcEndpoints } from './protocol.ts'
import { redact } from './redact.ts'
import { sessionFromTokens } from './session.ts'
import {
  SESSION_KEY,
  ensureRegistry,
  parseSession,
  recordSignInFailure,
  rememberPendingClient,
  rememberRegistration,
  toRecord,
  type Registration,
} from './store.ts'

const NEW_ACCOUNT = 'new'

export interface FlowDeps {
  credentials: () => CredentialProvider
  endpoints: SiwcEndpoints
  logger: Logger
  /** How long to wait for the browser round trip. */
  callbackTimeoutMs?: number
}

async function chooseRegistration(session: AuthorizationSession, saved: Registration[]): Promise<Registration | undefined> {
  if (!saved.length) return undefined
  const choice = await session.prompt({
    kind: 'select',
    message: 'Choose a ChatGPT account',
    options: [
      ...saved.map((r, i) => ({ id: String(i), label: r.email ?? `Account ${i + 1}`, description: 'Saved account' })),
      { id: NEW_ACCOUNT, label: 'Use a different ChatGPT account' },
    ],
  })
  return choice === NEW_ACCOUNT ? undefined : saved[Number(choice)]
}

export function createSignInFlow(deps: FlowDeps): AuthorizationFlow {
  return {
    key: SESSION_KEY,
    label: 'ChatGPT plan (Sign in with ChatGPT)',
    methods: [{ id: 'oauth', label: 'Continue with ChatGPT' }],
    async run(session) {
      const credentials = deps.credentials()
      try {
        await signIn(session, credentials)
        await recordSignInFailure(credentials, undefined)
      } catch (error) {
        // Cancellation is not a failure worth surfacing in /siwc status.
        if (!session.signal.aborted) {
          const message = redact(error instanceof Error ? error.message : String(error))
          await recordSignInFailure(credentials, { at: new Date().toISOString(), message }).catch(() => {})
          deps.logger.warn('sign-in failed: %s', message)
        }
        throw error
      }
    },
  }

  async function signIn(session: AuthorizationSession, credentials: CredentialProvider) {
    {
      const registry = await ensureRegistry(credentials)
      const pending = await chooseRegistration(session, registry.registrations)
      // A first registration that never completed: reuse its issued client id (docs: after
      // invalid_grant, retry "with the issued client ID retained for this attempt").
      const clientId = pending?.clientId
        ?? (registry.registrations.length === 0 ? registry.pendingClientId : undefined)
      const previous = parseSession(await credentials.readRecord(SESSION_KEY))

      const attempt = createAttempt()
      const listener = await listenForCallback(attempt.state, session.signal, deps.callbackTimeoutMs)
      try {
        session.notify({
          message: 'Continue with ChatGPT in your browser to finish signing in.',
          url: buildAuthorizeUrl(deps.endpoints, {
            clientId,
            hostId: registry.hostId,
            redirectUri: listener.redirectUri,
            attempt,
            loginHint: pending?.email,
          }),
        })

        // A browser-side `access_denied` is not a prompt decline, so DSH reports it as a
        // failed attempt; its message names the choice the docs ask us to offer.
        const outcome = readCallback(await listener.result, clientId)
        if (!clientId) await rememberPendingClient(credentials, outcome.clientId)

        const tokens = await exchangeCode(deps.endpoints, {
          clientId: outcome.clientId,
          code: outcome.code,
          verifier: attempt.verifier,
          redirectUri: listener.redirectUri,
        }, session.signal).catch((error: unknown) => {
          if (error instanceof SiwcAuthError && error.code === 'invalid_grant') {
            throw new SiwcAuthError(`${error.message}. The authorization code was discarded; start the sign-in again.`, 'invalid_grant', error.status)
          }
          throw error
        })
        if (!tokens.idToken) throw new SiwcAuthError('Token response carried no ID token', 'missing_id_token')

        const identity = await verifyIdToken(deps.endpoints, tokens.idToken, {
          clientId: outcome.clientId,
          nonce: attempt.nonce,
        })
        if (pending && identity.subject !== pending.subject) {
          throw new SiwcAuthError('Signed in to a different ChatGPT account than the one selected', 'subject_mismatch')
        }

        await rememberRegistration(credentials, {
          clientId: outcome.clientId,
          subject: identity.subject,
          email: identity.email ?? pending?.email,
        })

        // Replacing another account's live session: end its renewable grant first.
        if (previous?.refreshToken && (previous.clientId !== outcome.clientId || previous.subject !== identity.subject)) {
          const revoked = await revokeRefreshToken(deps.endpoints, { clientId: previous.clientId, refreshToken: previous.refreshToken })
          if (!revoked) deps.logger.warn('could not confirm revocation of the previously signed-in account')
        }

        await session.commit(toRecord(sessionFromTokens(tokens, {
          clientId: outcome.clientId,
          subject: identity.subject,
          email: identity.email ?? pending?.email,
          idToken: tokens.idToken,
        })))

        if (!hasPlanUsage(tokens.scopes)) {
          session.notify({
            message:
              `Signed in, but ChatGPT plan usage was not granted (${PLAN_USAGE_SCOPE}). ` +
              'Requests through this provider will fail until you sign in again and allow plan usage.',
          })
        } else if (!pending) {
          session.notify({
            message:
              "You're using your ChatGPT plan: eligible AI requests from this provider count toward your ChatGPT plan usage. " +
              'Manage usage in ChatGPT settings.',
            url: USAGE_SETTINGS_URL,
          })
        }
        deps.logger.info('signed in to ChatGPT (plan usage %s)', hasPlanUsage(tokens.scopes) ? 'enabled' : 'disabled')
      } finally {
        listener.close()
      }
    }
  }
}
