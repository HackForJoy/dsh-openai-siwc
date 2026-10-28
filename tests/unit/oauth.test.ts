import { request } from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildAuthorizeUrl,
  createAttempt,
  listenForCallback,
  parseEarliestRefreshAt,
  pkceChallenge,
  readCallback,
  safeEqual,
  verifyIdToken,
} from '../../src/oauth.ts'
import { OFFICIAL_ENDPOINTS } from '../../src/protocol.ts'
import { MockOpenAI } from '../helpers/mock-openai.ts'

describe('PKCE, state and nonce', () => {
  it('matches the RFC 7636 appendix B S256 test vector', () => {
    expect(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })

  it('creates fresh, unpadded, high-entropy values per attempt', () => {
    const a = createAttempt()
    const b = createAttempt()
    for (const v of [a.state, a.nonce, a.verifier]) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(a.state).not.toBe(b.state)
    expect(a.nonce).not.toBe(b.nonce)
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).toBe(pkceChallenge(a.verifier))
  })

  it('compares strings in constant time and rejects length mismatch', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })
})

describe('authorization URL', () => {
  const attempt = createAttempt()
  const base = { hostId: 'urn:uuid:00000000-0000-4000-8000-000000000000', redirectUri: 'http://127.0.0.1:5555/auth/callback', attempt }

  it('uses dynamic registration with agent_name_hint for a new account', () => {
    const q = new URL(buildAuthorizeUrl(OFFICIAL_ENDPOINTS, base)).searchParams
    expect(Object.fromEntries(q)).toEqual({
      client_id: 'dynamic_agent_client',
      agent_name_hint: 'DSH OpenAI SIWC',
      ext_agent_host_id: base.hostId,
      response_type: 'code',
      redirect_uri: base.redirectUri,
      scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
      resource: 'https://api.openai.com/v1',
      state: attempt.state,
      nonce: attempt.nonce,
      code_challenge_method: 'S256',
      code_challenge: attempt.challenge,
    })
  })

  it('uses the issued client id, omits agent_name_hint, and never sends an ID token for a returning account', () => {
    const q = new URL(buildAuthorizeUrl(OFFICIAL_ENDPOINTS, { ...base, clientId: 'oaiapp_x', loginHint: 'a@b.c' })).searchParams
    expect(q.get('client_id')).toBe('oaiapp_x')
    expect(q.has('agent_name_hint')).toBe(false)
    expect(q.has('id_token_hint')).toBe(false)
    expect(q.get('login_hint')).toBe('a@b.c')
  })
})

describe('callback validation', () => {
  const q = (params: Record<string, string>) => new URLSearchParams(params)

  it('accepts a new registration with an issued client id', () => {
    expect(readCallback(q({ code: 'c', client_id: 'oaiapp_1' }), undefined)).toEqual({ code: 'c', clientId: 'oaiapp_1' })
  })
  it('treats a new registration without an issued client id as incomplete', () => {
    expect(() => readCallback(q({ code: 'c' }), undefined)).toThrow(/Registration incomplete/)
    expect(() => readCallback(q({ code: 'c', client_id: 'dynamic_agent_client' }), undefined)).toThrow(/Registration incomplete/)
  })
  it('keeps the pending client id on reauthorization and rejects a different one', () => {
    expect(readCallback(q({ code: 'c' }), 'oaiapp_1').clientId).toBe('oaiapp_1')
    expect(() => readCallback(q({ code: 'c', client_id: 'oaiapp_2' }), 'oaiapp_1')).toThrow(/different client id/)
  })
  it('stops on OAuth errors before looking for a code', () => {
    expect(() => readCallback(q({ error: 'access_denied', code: 'c' }), undefined)).toThrow(/declined/)
    expect(() => readCallback(q({ error: 'server_error' }), undefined)).toThrow(/server_error/)
    expect(() => readCallback(q({}), undefined)).toThrow(/no authorization code/)
  })
})

describe('loopback callback listener', () => {
  const state = 'expected-state-value'
  const get = (url: string) => fetch(url)
  /** Raw request so the Host header can be forged (fetch forbids setting it). */
  const forgedHost = (url: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const req = request(url, { headers: { host } }, (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      })
      req.on('error', reject)
      req.end()
    })

  it('binds 127.0.0.1 on /auth/callback and refuses forged requests while it keeps waiting', async () => {
    const listener = await listenForCallback(state, new AbortController().signal)
    const base = listener.redirectUri
    expect(base).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    const port = new URL(base).port

    expect((await get(`${base}?state=wrong&code=x`)).status).toBe(400)
    expect((await get(`http://127.0.0.1:${port}/other?state=${state}`)).status).toBe(404)
    expect((await fetch(`${base}?state=${state}`, { method: 'POST' })).status).toBe(405)
    expect(await forgedHost(`${base}?state=${state}`, `localhost:${port}`)).toBe(400)
    expect(await forgedHost(`${base}?state=${state}`, 'evil.example')).toBe(400)

    const ok = await get(`${base}?state=${state}&code=abc`)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('cache-control')).toBe('no-store')
    expect(await ok.text()).not.toContain('abc')
    expect((await listener.result).get('code')).toBe('abc')
    await expect(get(`${base}?state=${state}`)).rejects.toThrow()
  })

  it('rejects and closes when the attempt is cancelled', async () => {
    const controller = new AbortController()
    const listener = await listenForCallback(state, controller.signal)
    controller.abort(new Error('user cancelled'))
    await expect(listener.result).rejects.toThrow('user cancelled')
    await expect(get(`${listener.redirectUri}?state=${state}`)).rejects.toThrow()
  })

  it('times out', async () => {
    const listener = await listenForCallback(state, new AbortController().signal, 50)
    await expect(listener.result).rejects.toThrow(/Timed out/)
  })
})

describe('ID token validation', () => {
  let mock: MockOpenAI
  beforeAll(async () => {
    mock = await new MockOpenAI().start()
  })
  afterAll(() => mock.stop())

  const claims = () => ({ iss: mock.base, aud: 'oaiapp_1', sub: 'sub-1', email: 'e@x.y', nonce: 'n-1' })
  const verify = (token: string, nonce: string | null = 'n-1') => verifyIdToken(mock.endpoints, token, { clientId: 'oaiapp_1', nonce: nonce ?? undefined })

  it('accepts a correctly signed token and returns the subject', async () => {
    expect(await verify(await mock.signIdToken(claims()))).toEqual({ subject: 'sub-1', email: 'e@x.y' })
  })
  it.each([
    ['issuer', { iss: 'https://evil.example' }],
    ['audience', { aud: 'oaiapp_other' }],
    ['nonce', { nonce: 'n-2' }],
    ['missing nonce', { nonce: undefined }],
    ['missing subject', { sub: undefined }],
  ])('rejects a wrong %s', async (_, override) => {
    await expect(verify(await mock.signIdToken({ ...claims(), ...override }))).rejects.toThrow(/ID token failed validation/)
  })
  it('rejects an expired token', async () => {
    await expect(verify(await mock.signIdToken(claims(), { expSeconds: -60 }))).rejects.toThrow(/ID token failed validation/)
  })
  it('rejects a token signed by an unpublished key', async () => {
    await expect(verify(await mock.signIdToken(claims(), { rogue: true }))).rejects.toThrow(/ID token failed validation/)
  })
  it('skips the nonce only when none is expected (refresh responses)', async () => {
    const { nonce: _, ...noNonce } = claims()
    expect((await verify(await mock.signIdToken(noNonce), null)).subject).toBe('sub-1')
  })
})

describe('earliest_refresh_at parsing (format undocumented)', () => {
  it('accepts epoch seconds, epoch ms, and date strings; ignores anything else', () => {
    expect(parseEarliestRefreshAt(1_790_000_000)).toBe(1_790_000_000_000)
    expect(parseEarliestRefreshAt(1_790_000_000_000)).toBe(1_790_000_000_000)
    expect(parseEarliestRefreshAt('2026-10-28T00:00:00Z')).toBe(Date.parse('2026-10-28T00:00:00Z'))
    expect(parseEarliestRefreshAt('soon')).toBeUndefined()
    expect(parseEarliestRefreshAt(null)).toBeUndefined()
    expect(parseEarliestRefreshAt(-5)).toBeUndefined()
  })
})
