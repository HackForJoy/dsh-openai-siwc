import { describe, expect, it } from 'vitest'
import { providerError, retryAfterMs } from '../../src/errors.ts'
import { redact } from '../../src/redact.ts'
import { needsRefresh, REFRESH_SKEW_MS } from '../../src/session.ts'
import { parseRegistry, parseSession, toRecord, type SessionTokens } from '../../src/store.ts'
import { formatStatus } from '../../src/commands.ts'

describe('providerError mapping (errors-and-recovery)', () => {
  it.each([
    ['subscription_sharing_user_not_eligible', 403, 'SIWC_NOT_ELIGIBLE'],
    ['subscription_sharing_usage_limit_exceeded', 429, 'QUOTA'],
    ['subscription_sharing_usage_unavailable', 503, 'SERVER'],
    ['subscription_sharing_unsupported_capability', 400, 'SIWC_UNSUPPORTED_CAPABILITY'],
    ['subscription_sharing_route_not_supported', 403, 'SIWC_ROUTE_NOT_SUPPORTED'],
    ['subscription_sharing_invalid_user', 401, 'AUTH'],
    ['chatpass_v2_scope_not_authorized', 403, 'SIWC_SCOPE_NOT_AUTHORIZED'],
    ['chatpass_v2_invalid_authorization_context', 403, 'SIWC_SCOPE_NOT_AUTHORIZED'],
    ['subscription_sharing_user_unavailable', 503, 'SERVER'],
  ])('%s → %s', (errorCode, status, code) => {
    expect(providerError({ errorCode, status }).code).toBe(code)
  })

  it.each([
    [401, 'AUTH'],
    [403, 'SIWC_FORBIDDEN'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [503, 'SERVER'],
    [400, 'SIWC_REQUEST_REJECTED'],
  ])('falls back to HTTP %i → %s', (status, code) => {
    expect(providerError({ status }).code).toBe(code)
  })

  it('recognizes context overflow', () => {
    expect(providerError({ status: 400, errorCode: 'context_length_exceeded' }).code).toBe('CONTEXT_WINDOW_EXCEEDED')
  })

  it('keeps status and request id, and scrubs secrets from detail', () => {
    const e = providerError({ status: 401, detail: 'bad token Bearer abcdefghijklmnop', requestId: 'req_9' })
    expect(e.failure).toMatchObject({ status: 401, requestId: 'req_9' })
    expect(e.message).toContain('request id req_9')
    expect(e.message).not.toContain('abcdefghijklmnop')
  })

  it('parses retry-after seconds', () => {
    expect(retryAfterMs('3')).toBe(3000)
    expect(retryAfterMs(null)).toBeUndefined()
    expect(retryAfterMs('0')).toBeUndefined()
  })
})

describe('redact', () => {
  const jwt = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJlLXZhbHVl'
  it.each([
    [`id_token=${jwt}`, jwt],
    ['Authorization: Bearer at_0123456789abcdef', 'at_0123456789abcdef'],
    ['https://x/cb?code=SECRETCODE&state=SECRETSTATE', 'SECRETCODE'],
    ['https://x/cb?code=SECRETCODE&state=SECRETSTATE', 'SECRETSTATE'],
    ['{"refresh_token":"rt_secret_value"}', 'rt_secret_value'],
    ['{"accessToken":"at_secret_value"}', 'at_secret_value'],
  ])('removes secrets from %s', (input, secret) => {
    expect(redact(input)).not.toContain(secret)
  })

  it('bounds length', () => {
    expect(redact('x'.repeat(2000)).length).toBeLessThanOrEqual(501)
  })
})

describe('credential records', () => {
  const session: SessionTokens = {
    version: 1, clientId: 'oaiapp_1', subject: 's', idToken: 'i', accessToken: 'a', expiresAt: 1, scopes: ['openid'], savedAt: 'now',
    email: undefined, refreshToken: undefined, earliestRefreshAt: undefined,
  }

  it('drops undefined optional fields so the JSON-only store accepts the record', () => {
    const record = toRecord(session)
    expect(record.kind === 'grant' && Object.values(record.payload as object).includes(undefined)).toBe(false)
    expect(parseSession(record)).toEqual(session)
  })

  it('treats malformed or foreign payloads as absent', () => {
    expect(parseSession({ kind: 'api-key', key: 'k' })).toBeUndefined()
    expect(parseSession({ kind: 'grant', payload: { version: 2 } })).toBeUndefined()
    expect(parseSession({ kind: 'grant', payload: { ...session, accessToken: 5 } })).toBeUndefined()
    expect(parseRegistry({ kind: 'grant', payload: { version: 1, hostId: 'h', registrations: [{ clientId: 'c' }, 'x'] } }))
      .toEqual({ version: 1, hostId: 'h', registrations: [] })
  })
})

describe('needsRefresh', () => {
  const now = 1_000_000_000
  const s = (expiresAt: number, earliestRefreshAt?: number) => ({ expiresAt, earliestRefreshAt }) as SessionTokens

  it('refreshes within the skew window and after expiry', () => {
    expect(needsRefresh(s(now + REFRESH_SKEW_MS + 1), now)).toBe(false)
    expect(needsRefresh(s(now + REFRESH_SKEW_MS - 1), now)).toBe(true)
    expect(needsRefresh(s(now - 1), now)).toBe(true)
  })

  it('defers an early refresh until earliest_refresh_at but never past expiry', () => {
    expect(needsRefresh(s(now + 10, now + 5), now)).toBe(false)
    expect(needsRefresh(s(now - 1, now + 5), now)).toBe(true)
  })
})

describe('status formatting', () => {
  it('shortens the client id and shows plan usage state', () => {
    const text = formatStatus({ signedIn: true, email: 'a@b.c', clientId: 'oaiapp_ABCDEFGHIJKLMNOP', scopes: ['openid'], planUsage: false, expiresInSeconds: 10, hasRefreshToken: true })
    expect(text).not.toContain('oaiapp_ABCDEFGHIJKLMNOP')
    expect(text).toContain('disabled (chatgpt.tokens.use.direct not granted)')
  })
})
