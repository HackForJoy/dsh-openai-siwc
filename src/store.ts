/**
 * The two credential records this plugin owns, stored through the DSH
 * credential seam (`ctx.credentials`). Payloads are parsed defensively: they
 * come from a file on disk that other tools or the user may have edited.
 */
import { randomUUID } from 'node:crypto'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** cordis plugin name; also the scope of every record this plugin writes. */
export const PLUGIN_NAME = 'openai-siwc'

/** Host id and known account registrations; survives sign-out. */
export const REGISTRY_KEY: CredentialKey = credentialKey(PLUGIN_NAME, 'registry')
/** Tokens of the signed-in account; presence means "signed in". */
export const SESSION_KEY: CredentialKey = credentialKey(PLUGIN_NAME, 'session')

export interface Registration {
  /** Issued `oaiapp_...` client id; never `dynamic_agent_client`. */
  clientId: string
  /** Validated ID-token subject. */
  subject: string
  email?: string
}

/** Non-secret record of the most recent failed sign-in, for `/siwc status`. */
export interface SignInFailure {
  /** ISO-8601 time of the failure. */
  at: string
  /** Redacted, bounded error message. */
  message: string
}

export interface Registry {
  version: 1
  /** Stable opaque `urn:uuid:` host identifier. */
  hostId: string
  registrations: Registration[]
  /**
   * Issued client id from a new-registration callback whose sign-in has not
   * completed yet. The docs require retrying with it after `invalid_grant`
   * instead of registering another client.
   */
  pendingClientId?: string
  lastSignInError?: SignInFailure
}

export interface SessionTokens {
  version: 1
  clientId: string
  subject: string
  email?: string
  idToken: string
  accessToken: string
  refreshToken?: string
  /** Epoch milliseconds. */
  expiresAt: number
  /** Epoch milliseconds, when the token response supplied a usable value. */
  earliestRefreshAt?: number
  scopes: string[]
  /** ISO-8601 time the token response was received. */
  savedAt: string
}

const isString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
export const isPositiveFinite = (value: unknown): value is number => isFiniteNumber(value) && value > 0

function grantPayload(record: CredentialRecord | undefined): unknown {
  return record?.kind === 'grant' ? record.payload : undefined
}

export function parseRegistry(record: CredentialRecord | undefined): Registry | undefined {
  const p = grantPayload(record)
  if (!isObject(p) || p.version !== 1 || !isString(p.hostId) || !Array.isArray(p.registrations)) return
  const registrations = p.registrations.filter(
    (r): r is Registration => isObject(r) && isString(r.clientId) && isString(r.subject),
  )
  const failure = p.lastSignInError
  const lastSignInError = isObject(failure) && isString(failure.at) && isString(failure.message)
    ? { at: failure.at, message: failure.message }
    : undefined
  const pendingClientId = isString(p.pendingClientId) ? p.pendingClientId : undefined
  return { version: 1, hostId: p.hostId, registrations, pendingClientId, lastSignInError }
}

export function parseSession(record: CredentialRecord | undefined): SessionTokens | undefined {
  const p = grantPayload(record)
  if (!isObject(p) || p.version !== 1) return
  if (!isString(p.clientId) || !isString(p.subject) || !isString(p.idToken) || !isString(p.accessToken)) return
  if (!isPositiveFinite(p.expiresAt) || !Array.isArray(p.scopes) || !isString(p.savedAt)) return
  // Optional, but a present value must be a usable time; anything else marks the record malformed.
  if (p.earliestRefreshAt !== undefined && !isFiniteNumber(p.earliestRefreshAt)) return
  return {
    version: 1,
    clientId: p.clientId,
    subject: p.subject,
    email: isString(p.email) ? p.email : undefined,
    idToken: p.idToken,
    accessToken: p.accessToken,
    refreshToken: isString(p.refreshToken) ? p.refreshToken : undefined,
    expiresAt: p.expiresAt,
    earliestRefreshAt: p.earliestRefreshAt,
    scopes: p.scopes.filter(isString),
    savedAt: p.savedAt,
  }
}

/** The store accepts only JSON values, so optional fields left `undefined` are dropped here. */
export const toRecord = (payload: Registry | SessionTokens): CredentialRecord => ({
  kind: 'grant',
  payload: JSON.parse(JSON.stringify(payload)),
})

/**
 * Return this host's id, creating and persisting it before first use.
 * @param credentials - the DSH credential seam.
 */
export async function ensureRegistry(credentials: CredentialProvider): Promise<Registry> {
  let result: Registry | undefined
  await credentials.modifyRecord(REGISTRY_KEY, async (current) => {
    result = parseRegistry(current)
    if (result) return undefined
    result = { version: 1, hostId: `urn:uuid:${randomUUID()}`, registrations: [] }
    return toRecord(result)
  })
  return result!
}

/** Remember (or with `undefined`, clear) the most recent sign-in failure. */
export async function recordSignInFailure(credentials: CredentialProvider, failure: SignInFailure | undefined): Promise<void> {
  await credentials.modifyRecord(REGISTRY_KEY, async (current) => {
    const registry = parseRegistry(current)
    if (!registry || (!failure && !registry.lastSignInError)) return undefined
    return toRecord({ ...registry, lastSignInError: failure })
  })
}

/** Keep an issued client id from a callback until its sign-in completes. */
export async function rememberPendingClient(credentials: CredentialProvider, clientId: string): Promise<void> {
  await credentials.modifyRecord(REGISTRY_KEY, async (current) => {
    const registry = parseRegistry(current)
    if (!registry || registry.pendingClientId === clientId) return undefined
    return toRecord({ ...registry, pendingClientId: clientId })
  })
}

/** Record (or update the email of) an account registration bound to its issued client id. */
export async function rememberRegistration(credentials: CredentialProvider, registration: Registration): Promise<void> {
  await credentials.modifyRecord(REGISTRY_KEY, async (current) => {
    const registry = parseRegistry(current)
    if (!registry) throw new Error('openai-siwc: host registry disappeared during sign-in')
    const others = registry.registrations.filter(
      (r) => !(r.clientId === registration.clientId && r.subject === registration.subject),
    )
    const pendingClientId = registry.pendingClientId === registration.clientId ? undefined : registry.pendingClientId
    return toRecord({ ...registry, pendingClientId, registrations: [...others, registration] })
  })
}
