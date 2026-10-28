/**
 * `/siwc login | status | models | logout`: sign-in, diagnostics and sign-out.
 * Output never contains tokens; the client id is shortened and the host id is
 * opaque. DSH 0.2.1 has no generic settings UI for third-party authorization
 * flows, so `login` drives the registered flow from here.
 */
import { AuthorizationDeclinedError, type AuthorizationService } from '@deepseek-ai/dsh-authorization'
import type { CommandDefinition } from '@deepseek-ai/dsh-commands'
import type { SiwcAdapter } from './adapter.ts'
import type { OpenBrowser } from './browser.ts'
import { SESSION_KEY } from './store.ts'
import { hasPlanUsage } from './oauth.ts'
import { PLAN_USAGE_SCOPE, USAGE_SETTINGS_URL } from './protocol.ts'
import { redact } from './redact.ts'
import type { SiwcSession } from './session.ts'

const shorten = (id: string) => (id.length > 14 ? `${id.slice(0, 10)}…${id.slice(-4)}` : id)

export interface StatusFacts {
  signedIn: boolean
  email?: string
  clientId?: string
  scopes?: string[]
  planUsage?: boolean
  expiresInSeconds?: number
  hasRefreshToken?: boolean
  catalogError?: string
  lastSignInError?: { at: string; message: string }
}

export function formatStatus(f: StatusFacts): string {
  const failure = f.lastSignInError ? `\nLast sign-in failure (${f.lastSignInError.at}): ${f.lastSignInError.message}` : ''
  if (!f.signedIn) {
    return 'ChatGPT plan: not signed in. Run "/siwc login" (Continue with ChatGPT).' + failure +
      (f.catalogError ? `\nLast model-list error: ${f.catalogError}` : '')
  }
  const lines = [
    `ChatGPT plan: signed in${f.email ? ` as ${f.email}` : ''}`,
    `Client: ${shorten(f.clientId ?? '')}`,
    `Plan usage: ${f.planUsage ? 'enabled' : `disabled (${PLAN_USAGE_SCOPE} not granted)`}`,
    `Granted scopes: ${(f.scopes ?? []).join(' ') || '(none)'}`,
    `Access token: ${f.expiresInSeconds !== undefined && f.expiresInSeconds > 0 ? `valid for ${f.expiresInSeconds}s` : 'expired (refreshes on next request)'}` +
      `; refresh token ${f.hasRefreshToken ? 'present' : 'missing'}`,
    `Usage: ${USAGE_SETTINGS_URL}`,
  ]
  if (f.catalogError) lines.push(`Last model-list error: ${f.catalogError}`)
  return lines.join('\n') + failure
}

export interface LoginDeps {
  authorization: () => AuthorizationService
  /** Opens the authorization URL; the URL never enters command output or logs. */
  openBrowser: OpenBrowser
  /** Prefix identifying our own authorization URL among notices. */
  authorizeUrl: string
}

/**
 * Run the registered sign-in flow without a settings UI.
 * @param useNew - register another ChatGPT account instead of reusing the first saved one.
 */
async function login(deps: LoginDeps, session: SiwcSession, useNew: boolean, signal: AbortSignal): Promise<string> {
  const messages: string[] = []
  let openFailure: unknown
  const attempt = new AbortController()
  const onAbort = () => attempt.abort(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    const outcome = await deps.authorization().begin({
      key: SESSION_KEY,
      signal: attempt.signal,
      interaction: {
        notify(notice) {
          if (notice.url?.startsWith(deps.authorizeUrl)) {
            deps.openBrowser(notice.url).catch((error: unknown) => {
              openFailure = error
              attempt.abort(error)
            })
          } else {
            messages.push(notice.url ? `${notice.message} ${notice.url}` : notice.message)
          }
        },
        async prompt(p) {
          if (p.kind !== 'select') throw new AuthorizationDeclinedError()
          const saved = p.options.find((o) => o.id !== 'new')
          return useNew || !saved ? 'new' : saved.id
        },
      },
    })
    if (openFailure) {
      return `Could not open the system browser (${redact(String(openFailure))}). Sign-in was not started.`
    }
    if (outcome.status === 'cancelled') return 'Sign-in cancelled.'
    const s = await session.current()
    return [`Signed in to ChatGPT${s?.email ? ` as ${s.email}` : ''}.`, ...messages].join('\n')
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

export function createSiwcCommand(session: SiwcSession, adapter: SiwcAdapter, loginDeps?: LoginDeps): CommandDefinition {
  return {
    name: 'siwc',
    description: 'ChatGPT plan (Sign in with ChatGPT): login, status, models, logout',
    input: { hint: 'login [new] | status | models | logout' },
    async handler({ rawInput, signal }) {
      const sub = rawInput.trim() || 'status'
      try {
        switch (sub) {
          case 'login':
          case 'login new': {
            if (!loginDeps) return { kind: 'error', text: 'Sign-in is not available in this composition.' }
            adapter.invalidateCatalog()
            return { kind: 'success', text: await login(loginDeps, session, sub === 'login new', signal) }
          }
          case 'status': {
            const s = await session.current()
            const lastSignInError = (await session.registry())?.lastSignInError
            return {
              kind: 'success',
              text: formatStatus(s
                ? {
                    signedIn: true,
                    email: s.email,
                    clientId: s.clientId,
                    scopes: s.scopes,
                    planUsage: hasPlanUsage(s.scopes),
                    expiresInSeconds: Math.round((s.expiresAt - Date.now()) / 1000),
                    hasRefreshToken: !!s.refreshToken,
                    catalogError: adapter.lastCatalogError,
                    lastSignInError,
                  }
                : { signedIn: false, catalogError: adapter.lastCatalogError, lastSignInError }),
            }
          }
          case 'models': {
            adapter.invalidateCatalog()
            const models = await adapter.fetchCatalog(signal)
            return {
              kind: 'success',
              text: models.length
                ? `Models available to this ChatGPT account (provider "openai-siwc"):\n${models.map((m) => `- ${m.slug} — ${m.displayName}`).join('\n')}`
                : 'The model list for this ChatGPT account is empty.',
            }
          }
          case 'logout': {
            const result = await session.signOut()
            adapter.invalidateCatalog()
            if (!result.hadSession) return { kind: 'success', text: 'Not signed in; nothing to sign out.' }
            return {
              kind: 'success',
              text: result.revoked
                ? 'Signed out: the ChatGPT session was revoked and local tokens were removed.'
                : 'Signed out locally, but remote revocation was NOT confirmed. ' +
                  'You can disconnect this app in ChatGPT Settings to be sure.',
            }
          }
          default:
            return { kind: 'error', text: `Unknown subcommand "${redact(sub)}". Use: login [new] | status | models | logout` }
        }
      } catch (error) {
        return { kind: 'error', text: redact(error instanceof Error ? error.message : String(error)) }
      }
    },
  }
}
