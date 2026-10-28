/**
 * Fixed protocol facts from the official SIWC documentation. Every value here
 * is cited in docs/research/openai-siwc-protocol.md; nothing is configurable
 * through plugin settings, so a tampered configuration cannot redirect tokens.
 */

/** Endpoints a running plugin talks to. Tests substitute a mock set. */
export interface SiwcEndpoints {
  /** OIDC issuer; also the expected `iss` of every ID token. */
  issuer: string
  authorize: string
  token: string
  revoke: string
  jwks: string
  /** Responses API base, also the OAuth `resource` and access-token audience. */
  apiBase: string
}

export const OFFICIAL_ENDPOINTS: SiwcEndpoints = Object.freeze({
  issuer: 'https://auth.openai.com',
  authorize: 'https://auth.openai.com/api/accounts/authorize',
  token: 'https://auth.openai.com/api/accounts/oauth/token',
  revoke: 'https://auth.openai.com/api/accounts/oauth/revoke',
  jwks: 'https://auth.openai.com/.well-known/jwks.json',
  apiBase: 'https://api.openai.com/v1',
})

/** The OAuth `resource` is always the official API base, even against a mock. */
export const RESOURCE = 'https://api.openai.com/v1'

/** First-registration entry point. Never stored, never used for token exchange. */
export const DYNAMIC_CLIENT_ID = 'dynamic_agent_client'

/** The app name the user sees while approving the agent (chosen by the user). */
export const AGENT_NAME_HINT = 'DSH OpenAI SIWC'

export const SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  'chatgpt.tokens.use.direct',
] as const

/** Without this granted scope, ChatGPT plan inference must not be attempted. */
export const PLAN_USAGE_SCOPE = 'chatgpt.tokens.use.direct'

export const CALLBACK_PATH = '/auth/callback'
export const LOOPBACK_HOST = '127.0.0.1'

/** Refresh-token errors after which the stored tokens are unusable. */
export const TERMINAL_REFRESH_ERRORS = new Set([
  'invalid_grant',
  'invalid_refresh_token',
  'token_expired',
  'refresh_token_expired',
  'refresh_token_invalidated',
  'refresh_token_reused',
])

export const USAGE_SETTINGS_URL = 'https://chatgpt.com/settings/usage'
