/**
 * A local stand-in for auth.openai.com and api.openai.com, implementing the
 * documented SIWC contract strictly enough that a protocol mistake fails a
 * test: PKCE is verified, redirect_uri/resource/client_id must match,
 * refresh tokens rotate and reuse is rejected, inference requests must carry
 * store:false/stream:true and none of the forbidden fields.
 */
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SignJWT, exportJWK, generateKeyPair, type CryptoKey, type JWK } from 'jose'
import type { SiwcEndpoints } from '../../src/protocol.ts'

export const ISSUED_CLIENT_ID = 'oaiapp_test_client_0001'
export const SUBJECT = 'user-subject-123'
export const EMAIL = 'tester@example.com'
const ALL_SCOPES = 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke'

const FORBIDDEN_FIELDS = [
  'background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent',
  'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation',
  'user', 'previous_response_id',
]

export type SseEvent = Record<string, unknown> & { type: string }

export interface MockOptions {
  /** Scope string granted at code exchange. */
  grantedScope?: string
  /** Server-side access-token lifetime. */
  expiresIn?: number
  /** Answer authorize with error=access_denied. */
  denyConsent?: boolean
  /** Omit the issued client_id from a first-registration callback. */
  omitClientId?: boolean
  /** Sign ID tokens with a key that is not in the JWKS. */
  rogueSigner?: boolean
  /** Override the ID token `sub`. */
  subject?: string
}

interface AuthCode {
  clientId: string
  challenge: string
  redirectUri: string
  nonce: string
}

export class MockOpenAI {
  server!: Server
  base = ''
  private key!: { privateKey: CryptoKey; publicKey: CryptoKey }
  private rogue!: { privateKey: CryptoKey }
  private jwk!: JWK
  private codes = new Map<string, AuthCode>()
  /** Live refresh tokens → client id. */
  refreshTokens = new Map<string, string>()
  private usedRefreshTokens = new Set<string>()
  /** Live access tokens. */
  accessTokens = new Set<string>()
  revoked: string[] = []
  authorizeRequests: URLSearchParams[] = []
  tokenRequests: URLSearchParams[] = []
  responsesBodies: Record<string, unknown>[] = []
  /** Next Responses answer: SSE events, or an HTTP error. */
  nextResponse: { events: SseEvent[]; truncate?: boolean; contentType?: string | null } | { status: number; json: unknown; headers?: Record<string, string> } = {
    events: textEvents('Hello, world!'),
  }
  /** Shaped like the live catalog (2026-10-28), including the client-only `ultra` level. */
  models: unknown = {
    models: [
      {
        slug: 'model-a', display_name: 'Model A', description: 'Vision and reasoning', visibility: 'list',
        input_modalities: ['text', 'image'], context_window: 500000, default_reasoning_level: 'low',
        supported_reasoning_levels: [
          { effort: 'low', description: 'Fast' }, { effort: 'medium', description: 'Balanced' },
          { effort: 'high', description: 'Deep' }, { effort: 'xhigh', description: 'Deeper' },
          { effort: 'max', description: 'Deepest' }, { effort: 'ultra', description: 'Client-only delegation' },
        ],
      },
      { slug: 'model-hidden', display_name: 'Hidden', visibility: 'hide' },
      { slug: 'model-b', display_name: 'Model B', visibility: 'list', input_modalities: ['text'] },
    ],
  }
  /** Fail the next code exchange with this OAuth error body. */
  exchangeFailure: { error: string; error_description?: string } | undefined
  /** Fail the next refresh with this OAuth error / status. */
  refreshFailure: { status: number; error: string } | undefined

  constructor(public options: MockOptions = {}) {}

  get endpoints(): SiwcEndpoints {
    return {
      issuer: this.base,
      authorize: `${this.base}/api/accounts/authorize`,
      token: `${this.base}/api/accounts/oauth/token`,
      revoke: `${this.base}/api/accounts/oauth/revoke`,
      jwks: `${this.base}/.well-known/jwks.json`,
      apiBase: `${this.base}/v1`,
    }
  }

  async start() {
    this.key = await generateKeyPair('RS256')
    this.rogue = await generateKeyPair('RS256')
    this.jwk = { ...(await exportJWK(this.key.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
    this.server = createServer((req, res) => {
      this.route(req, res).catch((error) => {
        res.writeHead(500).end(String(error))
      })
    })
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r))
    this.base = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`
    return this
  }

  async stop() {
    this.server.closeAllConnections()
    await new Promise((r) => this.server.close(r))
  }

  /** Sign an arbitrary ID token with the published (or rogue) key. */
  async signIdToken(claims: Record<string, unknown>, opts: { rogue?: boolean; expSeconds?: number; alg?: string } = {}) {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: 'k1' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expSeconds ?? 3600))
    return jwt.sign(opts.rogue ? this.rogue.privateKey : this.key.privateKey)
  }

  /** Act as the browser: open the authorize URL and follow the redirect to the loopback callback. */
  async completeBrowserSignIn(authorizeUrl: string): Promise<number> {
    const res = await fetch(authorizeUrl, { redirect: 'manual' })
    const location = res.headers.get('location')
    if (!location) throw new Error(`authorize returned ${res.status} without redirect`)
    const callback = await fetch(location)
    await callback.text()
    return callback.status
  }

  private async issueTokens(clientId: string, nonce?: string) {
    const access = `at_${randomBytes(12).toString('hex')}`
    const refresh = `rt_${randomBytes(12).toString('hex')}`
    this.accessTokens.add(access)
    this.refreshTokens.set(refresh, clientId)
    const idToken = await this.signIdToken(
      { iss: this.base, aud: clientId, sub: this.options.subject ?? SUBJECT, email: EMAIL, ...(nonce ? { nonce } : {}) },
      { rogue: this.options.rogueSigner },
    )
    return {
      access_token: access,
      refresh_token: refresh,
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: this.options.expiresIn ?? 3600,
      scope: this.options.grantedScope ?? ALL_SCOPES,
      earliest_refresh_at: Math.floor(Date.now() / 1000),
    }
  }

  private async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', this.base)
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
    }
    const form = async () => new URLSearchParams(await readBody(req))

    if (url.pathname === '/api/accounts/authorize') {
      const q = url.searchParams
      this.authorizeRequests.push(q)
      const redirect = new URL(q.get('redirect_uri')!)
      redirect.searchParams.set('state', q.get('state')!)
      if (this.options.denyConsent) {
        redirect.searchParams.set('error', 'access_denied')
      } else {
        const code = `code_${randomBytes(8).toString('hex')}`
        const isNew = q.get('client_id') === 'dynamic_agent_client'
        const clientId = isNew ? ISSUED_CLIENT_ID : q.get('client_id')!
        this.codes.set(code, { clientId, challenge: q.get('code_challenge')!, redirectUri: q.get('redirect_uri')!, nonce: q.get('nonce')! })
        redirect.searchParams.set('code', code)
        redirect.searchParams.set('scope', this.options.grantedScope ?? ALL_SCOPES)
        if (isNew && !this.options.omitClientId) redirect.searchParams.set('client_id', clientId)
      }
      res.writeHead(302, { location: redirect.toString() }).end()
      return
    }

    if (url.pathname === '/api/accounts/oauth/token' && req.method === 'POST') {
      const p = await form()
      this.tokenRequests.push(p)
      if (p.get('client_secret')) return json(400, { error: 'invalid_request' })
      if (p.get('resource') !== 'https://api.openai.com/v1') return json(400, { error: 'invalid_target' })
      if (p.get('grant_type') === 'authorization_code') {
        if (this.exchangeFailure) {
          const f = this.exchangeFailure
          this.exchangeFailure = undefined
          return json(400, f, { 'openai-request-id': 'req_auth_42' })
        }
        const code = this.codes.get(p.get('code') ?? '')
        this.codes.delete(p.get('code') ?? '')
        if (!code) return json(400, { error: 'invalid_grant' })
        const challenge = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url')
        if (challenge !== code.challenge || p.get('redirect_uri') !== code.redirectUri || p.get('client_id') !== code.clientId) {
          return json(400, { error: 'invalid_grant' })
        }
        return json(200, await this.issueTokens(code.clientId, code.nonce))
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (p.get('scope')) return json(400, { error: 'invalid_scope' })
        if (this.refreshFailure) {
          const f = this.refreshFailure
          this.refreshFailure = undefined
          return json(f.status, { error: f.error })
        }
        const token = p.get('refresh_token') ?? ''
        if (this.usedRefreshTokens.has(token)) return json(400, { error: 'refresh_token_reused' })
        const clientId = this.refreshTokens.get(token)
        if (!clientId || clientId !== p.get('client_id')) return json(400, { error: 'invalid_grant' })
        this.refreshTokens.delete(token)
        this.usedRefreshTokens.add(token)
        const tokens = await this.issueTokens(clientId)
        delete (tokens as Partial<typeof tokens>).id_token
        return json(200, tokens)
      }
      return json(400, { error: 'unsupported_grant_type' })
    }

    if (url.pathname === '/api/accounts/oauth/revoke' && req.method === 'POST') {
      const p = await form()
      this.revoked.push(p.get('token') ?? '')
      this.refreshTokens.delete(p.get('token') ?? '')
      res.writeHead(200).end()
      return
    }

    if (url.pathname === '/.well-known/jwks.json') return json(200, { keys: [this.jwk] })

    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? ''
    if (url.pathname.startsWith('/v1/') && !this.accessTokens.has(bearer)) {
      return json(401, { detail: 'Signed identity was not accepted' })
    }
    if (url.pathname === '/v1/models' && req.method === 'GET') return json(200, this.models)
    if (url.pathname === '/v1/responses' && req.method === 'POST') {
      const body = JSON.parse(await readBody(req)) as Record<string, unknown>
      this.responsesBodies.push(body)
      const forbidden = FORBIDDEN_FIELDS.filter((f) => f in body)
      if (body.store !== false || body.stream !== true || forbidden.length) {
        return json(400, { error: { code: 'subscription_sharing_unsupported_capability', param: forbidden[0] ?? 'store', message: 'unsupported' } })
      }
      const answer = this.nextResponse
      if ('status' in answer) return json(answer.status, answer.json, { 'x-oai-request-id': 'req_mock_1', ...answer.headers })
      // Like the live endpoint (2026-10-28): SSE body, no Content-Type, request id in x-oai-request-id.
      const headers: Record<string, string> = { 'x-oai-request-id': 'req_mock_1' }
      if (answer.contentType) headers['content-type'] = answer.contentType
      res.writeHead(200, headers)
      for (const event of answer.events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
      if (answer.truncate) res.destroy()
      else res.end()
      return
    }
    json(404, { error: 'not_found' })
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => (data += c))
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

export function textEvents(text: string, usage = { input_tokens: 12, output_tokens: 4, total_tokens: 16 }): SseEvent[] {
  const half = Math.ceil(text.length / 2)
  return [
    { type: 'response.created', response: { id: 'resp_1' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'msg_1', type: 'message' } },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text.slice(0, half) },
    { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text.slice(half) },
    { type: 'response.output_text.done', item_id: 'msg_1', output_index: 0, content_index: 0, text },
    { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage } },
  ]
}

export function toolCallEvents(name: string, args: string): SseEvent[] {
  return [
    { type: 'response.created', response: { id: 'resp_2' } },
    { type: 'response.output_item.added', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name, namespace: 'dsh', arguments: '' } },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: args.slice(0, 5) },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: args.slice(5) },
    { type: 'response.output_item.done', output_index: 0, item: { id: 'fc_1', type: 'function_call', call_id: 'call_1', name, namespace: 'dsh', arguments: args } },
    { type: 'response.completed', response: { id: 'resp_2', status: 'completed', usage: { input_tokens: 20, output_tokens: 8, total_tokens: 28 } } },
  ]
}
