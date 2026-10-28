/**
 * End-to-end against real DSH services (LLM runtime, authorization seam,
 * local credential store) and a mock OpenAI: sign-in, model discovery,
 * streaming inference, tool calls, refresh, failures, and sign-out.
 */
import { stat, readFile } from 'node:fs/promises'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BlockAssembler, createToolResultMessage, createUserMessage, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'
import { REGISTRY_KEY, SESSION_KEY, parseRegistry, parseSession, toRecord } from '../../src/store.ts'
import { createSiwcCommand } from '../../src/commands.ts'
import { EMAIL, ISSUED_CLIENT_ID, MockOpenAI, SUBJECT, textEvents, toolCallEvents } from '../helpers/mock-openai.ts'
import { mountHarness, signIn, type Harness } from '../helpers/harness.ts'
import { solidPng } from '../helpers/png.ts'

let mock: MockOpenAI
let h: Harness

async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []
  for await (const c of stream) chunks.push(c)
  return chunks
}

const ask = (text: string) => ({
  provider: 'openai-siwc',
  model: 'model-a',
  messages: [createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })],
})

beforeEach(async () => {
  mock = await new MockOpenAI().start()
  h = await mountHarness(mock)
})
afterEach(async () => {
  await h.dispose()
  await mock.stop()
})

describe('sign-in', () => {
  it('registers a new client through dynamic_agent_client and stores a validated session', async () => {
    const { outcome, callbackStatuses } = await signIn(h, mock)
    expect(outcome.status).toBe('authorized')
    expect(callbackStatuses).toEqual([200])

    const q = mock.authorizeRequests[0]!
    expect(q.get('client_id')).toBe('dynamic_agent_client')
    expect(q.get('agent_name_hint')).toBe('DSH OpenAI SIWC')
    expect(q.get('ext_agent_host_id')).toMatch(/^urn:uuid:[0-9a-f-]{36}$/)
    expect(q.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
    expect(q.get('scope')).toBe('openid profile email offline_access resource.invoke chatgpt.tokens.use.direct')
    expect(q.get('resource')).toBe('https://api.openai.com/v1')
    expect(q.get('code_challenge_method')).toBe('S256')
    expect(q.has('id_token_hint')).toBe(false)

    const exchange = mock.tokenRequests[0]!
    expect(exchange.get('client_id')).toBe(ISSUED_CLIENT_ID)
    expect(exchange.get('redirect_uri')).toBe(q.get('redirect_uri'))

    const session = parseSession(await h.ctx.credentials.readRecord(SESSION_KEY))!
    expect(session).toMatchObject({ clientId: ISSUED_CLIENT_ID, subject: SUBJECT, email: EMAIL })
    expect(session.scopes).toContain('chatgpt.tokens.use.direct')
    const registry = parseRegistry(await h.ctx.credentials.readRecord(REGISTRY_KEY))!
    expect(registry.hostId).toBe(q.get('ext_agent_host_id'))
    expect(registry.registrations).toEqual([{ clientId: ISSUED_CLIENT_ID, subject: SUBJECT, email: EMAIL }])
  })

  it('writes the credential file owner-only', async () => {
    await signIn(h, mock)
    const mode = (await stat(h.credentialsPath)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('reuses the issued client id and host id when signing in again', async () => {
    await signIn(h, mock)
    const hostId = mock.authorizeRequests[0]!.get('ext_agent_host_id')
    await signIn(h, mock, () => '0')
    const q = mock.authorizeRequests[1]!
    expect(q.get('client_id')).toBe(ISSUED_CLIENT_ID)
    expect(q.has('agent_name_hint')).toBe(false)
    expect(q.get('ext_agent_host_id')).toBe(hostId)
    expect(q.get('login_hint')).toBe(EMAIL)
    expect(q.get('state')).not.toBe(mock.authorizeRequests[0]!.get('state'))
  })

  it('stops without exchanging a code when consent is declined, storing nothing', async () => {
    mock.options.denyConsent = true
    await expect(signIn(h, mock)).rejects.toThrow(/declined in the browser.*another provider/)
    expect(mock.tokenRequests).toHaveLength(0)
    expect(await h.ctx.credentials.readRecord(SESSION_KEY)).toBeUndefined()
  })

  it('settles as cancelled when the user dismisses the account picker', async () => {
    await signIn(h, mock)
    const { AuthorizationDeclinedError } = await import('@deepseek-ai/dsh-authorization')
    const { outcome } = await signIn(h, mock, () => {
      throw new AuthorizationDeclinedError()
    })
    expect(outcome.status).toBe('cancelled')
    expect(mock.authorizeRequests).toHaveLength(1)
  })

  it('surfaces the token endpoint description and request id, records the failure, and clears it on success', async () => {
    mock.exchangeFailure = { error: 'invalid_grant', error_description: 'PKCE verification failed for code_verifier=abc' }
    const error = await signIn(h, mock).catch((e: Error) => e)
    expect(String(error)).toMatch(/invalid_grant: PKCE verification failed/)
    expect(String(error)).toContain('request id req_auth_42')
    expect(String(error)).not.toContain('code_verifier=abc')
    const recorded = parseRegistry(await h.ctx.credentials.readRecord(REGISTRY_KEY))!.lastSignInError!
    expect(recorded.message).toMatch(/start the sign-in again|invalid_grant/)
    const status = await createSiwcCommand(h.session, h.adapter).handler({ rawInput: 'status', signal: new AbortController().signal } as never)
    expect(status.text).toContain('Last sign-in failure')

    await signIn(h, mock)
    expect(parseRegistry(await h.ctx.credentials.readRecord(REGISTRY_KEY))!.lastSignInError).toBeUndefined()
  })

  it('retries a failed first registration with the retained issued client id instead of registering again', async () => {
    mock.exchangeFailure = { error: 'invalid_grant' }
    await expect(signIn(h, mock)).rejects.toThrow(/invalid_grant/)
    expect(parseRegistry(await h.ctx.credentials.readRecord(REGISTRY_KEY))!.pendingClientId).toBe(ISSUED_CLIENT_ID)

    const { outcome } = await signIn(h, mock)
    expect(outcome.status).toBe('authorized')
    const retry = mock.authorizeRequests[1]!
    expect(retry.get('client_id')).toBe(ISSUED_CLIENT_ID)
    expect(retry.has('agent_name_hint')).toBe(false)
    expect(mock.tokenRequests.at(-1)!.get('client_id')).toBe(ISSUED_CLIENT_ID)
    const registry = parseRegistry(await h.ctx.credentials.readRecord(REGISTRY_KEY))!
    expect(registry.pendingClientId).toBeUndefined()
    expect(registry.registrations).toHaveLength(1)
  })

  it('rejects a first registration whose callback lacks the issued client id', async () => {
    mock.options.omitClientId = true
    await expect(signIn(h, mock)).rejects.toThrow(/Registration incomplete/)
    expect(await h.ctx.credentials.readRecord(SESSION_KEY)).toBeUndefined()
  })

  it('rejects an ID token signed by a key outside the published JWKS', async () => {
    mock.options.rogueSigner = true
    await expect(signIn(h, mock)).rejects.toThrow(/ID token failed validation/)
    expect(await h.ctx.credentials.readRecord(SESSION_KEY)).toBeUndefined()
  })

  it('rejects a returning sign-in that comes back as a different account', async () => {
    await signIn(h, mock)
    mock.options.subject = 'someone-else'
    await expect(signIn(h, mock, () => '0')).rejects.toThrow(/different ChatGPT account/)
    expect(parseSession(await h.ctx.credentials.readRecord(SESSION_KEY))!.subject).toBe(SUBJECT)
  })

  it('keeps the sign-in but refuses inference when plan usage is not granted', async () => {
    mock.options.grantedScope = 'email offline_access openid profile'
    const { outcome, notices } = await signIn(h, mock)
    expect(outcome.status).toBe('authorized')
    expect(notices.some((n) => /plan usage was not granted/.test(n.message))).toBe(true)
    const chunks = await collect(h.ctx.llm.stream(ask('hi')))
    const finish = chunks.at(-1)!
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'SIWC_PLAN_USAGE_DISABLED' } } })
    expect(mock.responsesBodies).toHaveLength(0)
  })

  it('never leaves token material in notices', async () => {
    const { notices } = await signIn(h, mock)
    const session = parseSession(await h.ctx.credentials.readRecord(SESSION_KEY))!
    const text = JSON.stringify(notices)
    for (const secret of [session.accessToken, session.refreshToken!, session.idToken]) expect(text).not.toContain(secret)
  })
})

describe('models and inference', () => {
  beforeEach(async () => {
    await signIn(h, mock)
  })

  it('lists only visibility=list models in server order', async () => {
    const models = await h.ctx.llm.listModels('openai-siwc')
    expect(models.map((m) => m.id)).toEqual(['model-a', 'model-b'])
    expect(models[0]).toMatchObject({ name: 'Model A', inputModalities: ['text', 'image'] })
  })

  it('streams a text response and assembles it', async () => {
    const chunks = await collect(h.ctx.llm.stream(ask('Say hello')))
    const assembler = new BlockAssembler()
    for (const c of chunks) assembler.push(c)
    expect(assembler.blocks()).toEqual([{ type: 'text', text: 'Hello, world!' }])
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })

    const body = mock.responsesBodies[0]!
    expect(body).toMatchObject({ model: 'model-a', store: false, stream: true })
    expect(body.input).toEqual([{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Say hello' }] }])
  })

  it('emits a tool call and sends the result back on the next turn', async () => {
    mock.nextResponse = { events: toolCallEvents('read_file', '{"path":"README.md"}') }
    const tools = [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }]
    const first = await collect(h.ctx.llm.stream({ ...ask('read it'), tools }))
    const assembler = new BlockAssembler()
    for (const c of first) assembler.push(c)
    const [call] = assembler.blocks()
    expect(call).toEqual({ type: 'tool-call', id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}' })
    expect(first.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(mock.responsesBodies[0]!.tools).toEqual([{
      type: 'namespace',
      name: 'dsh',
      description: expect.any(String),
      tools: [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: tools[0]!.parameters }],
    }])

    mock.nextResponse = { events: textEvents('It says hi.') }
    const assistant = { id: 'm2', role: 'assistant', content: [call], source: { kind: 'model', provider: 'openai-siwc', model: 'model-a' } } as never
    const result = createToolResultMessage({ callId: 'call_1' as ToolCallId, content: [{ type: 'text', text: '# Title' }], isError: false })
    await collect(h.ctx.llm.stream({ ...ask('read it'), tools, messages: [...ask('read it').messages, assistant, result] }))
    expect(mock.responsesBodies[1]!.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'read it' }] },
      { type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"README.md"}', namespace: 'dsh' },
      { type: 'function_call_output', call_id: 'call_1', output: '# Title' },
    ])
  })

  it('maps a mid-stream usage-limit failure to QUOTA', async () => {
    mock.nextResponse = {
      events: [
        { type: 'response.output_text.delta', item_id: 'm', content_index: 0, delta: 'Hel' },
        { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } },
      ],
    }
    const finish = (await collect(h.ctx.llm.stream(ask('x')))).at(-1)!
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'QUOTA', requestId: 'req_mock_1' } } })
    expect(JSON.stringify(finish)).toContain('chatgpt.com/settings/usage')
  })

  it('maps a 403 not-eligible admission error without retryable code', async () => {
    mock.nextResponse = { status: 403, json: { error: { code: 'subscription_sharing_user_not_eligible', message: 'no' } } }
    const finish = (await collect(h.ctx.llm.stream(ask('x')))).at(-1)!
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'SIWC_NOT_ELIGIBLE', status: 403 } } })
  })

  it('maps a 503 admission detail body to retryable SERVER and honours retry-after', async () => {
    mock.nextResponse = { status: 503, json: { detail: 'Direct routing unavailable' }, headers: { 'retry-after': '7' } }
    const finish = (await collect(h.ctx.llm.stream(ask('x')))).at(-1)!
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'SERVER', status: 503, providerRetryAfterMs: 7000 } } })
  })

  it('accepts SSE with an explicit text/event-stream type and refuses an explicit non-SSE type', async () => {
    mock.nextResponse = { events: textEvents('ok'), contentType: 'text/event-stream; charset=utf-8' }
    expect((await collect(h.ctx.llm.stream(ask('x')))).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    mock.nextResponse = { events: textEvents('ok'), contentType: 'application/json' }
    const finish = (await collect(h.ctx.llm.stream(ask('x')))).at(-1)!
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'SIWC_REQUEST_REJECTED', requestId: 'req_mock_1' } } })
  })

  it('treats a stream that ends before response.completed as a transport failure', async () => {
    mock.nextResponse = { events: textEvents('partial').slice(0, 3), truncate: true }
    const finish = (await collect(h.ctx.llm.stream(ask('x')))).at(-1)!
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'TRANSPORT' } } })
  })

  it('reports cancellation as aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const finish = (await collect(h.ctx.llm.stream({ ...ask('x'), signal: controller.signal }))).at(-1)!
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
  })

  it('refuses temperature explicitly instead of dropping it', async () => {
    const finish = (await collect(h.ctx.llm.stream({ ...ask('x'), temperature: 0.2 }))).at(-1)!
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'UNSUPPORTED_PARAMETER' } } })
    expect(mock.responsesBodies).toHaveLength(0)
  })

  it('does not send max_output_tokens when DSH passes maxTokens', async () => {
    await collect(h.ctx.llm.stream({ ...ask('x'), maxTokens: 8192 }))
    expect(mock.responsesBodies[0]).not.toHaveProperty('max_output_tokens')
  })
})

describe('token refresh', () => {
  async function expireStoredToken() {
    await h.ctx.credentials.modifyRecord(SESSION_KEY, async (r) => toRecord({ ...parseSession(r)!, expiresAt: Date.now() - 1000, earliestRefreshAt: undefined }))
  }

  beforeEach(async () => {
    await signIn(h, mock)
  })

  it('refreshes an expired token with the issued client id and rotates the refresh token', async () => {
    const before = parseSession(await h.ctx.credentials.readRecord(SESSION_KEY))!
    await expireStoredToken()
    await collect(h.ctx.llm.stream(ask('x')))
    const refresh = mock.tokenRequests.find((p) => p.get('grant_type') === 'refresh_token')!
    expect(refresh.get('client_id')).toBe(ISSUED_CLIENT_ID)
    expect(refresh.has('scope')).toBe(false)
    expect(refresh.get('resource')).toBe('https://api.openai.com/v1')
    const after = parseSession(await h.ctx.credentials.readRecord(SESSION_KEY))!
    expect(after.refreshToken).not.toBe(before.refreshToken)
    expect(after.accessToken).not.toBe(before.accessToken)
    expect(after.idToken).toBe(before.idToken)
    expect(after.expiresAt).toBeGreaterThan(Date.now())
  })

  it('serializes concurrent refreshes so the rotating token is used once', async () => {
    await expireStoredToken()
    const results = await Promise.all([1, 2, 3].map(() => collect(h.ctx.llm.stream(ask('x')))))
    for (const r of results) expect(r.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(mock.tokenRequests.filter((p) => p.get('grant_type') === 'refresh_token')).toHaveLength(1)
  })

  it('clears tokens and asks to sign in again after a terminal refresh error', async () => {
    await expireStoredToken()
    mock.refreshFailure = { status: 400, error: 'refresh_token_expired' }
    const finish = (await collect(h.ctx.llm.stream(ask('x')))).at(-1)!
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'AUTH' } } })
    expect(await h.ctx.credentials.readRecord(SESSION_KEY)).toBeUndefined()
    expect(parseRegistry(await h.ctx.credentials.readRecord(REGISTRY_KEY))!.registrations).toHaveLength(1)
  })

  it('keeps credentials on a transient refresh failure', async () => {
    await expireStoredToken()
    mock.refreshFailure = { status: 503, error: 'temporarily_unavailable' }
    const finish = (await collect(h.ctx.llm.stream(ask('x')))).at(-1)!
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'TRANSPORT' } } })
    expect(await h.ctx.credentials.readRecord(SESSION_KEY)).toBeDefined()
  })

  it('reports a server-side revoked access token as AUTH without deleting credentials', async () => {
    mock.accessTokens.clear()
    const finish = (await collect(h.ctx.llm.stream(ask('x')))).at(-1)!
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'AUTH', status: 401 } } })
    expect(await h.ctx.credentials.readRecord(SESSION_KEY)).toBeDefined()
  })
})

describe('/siwc command and sign-out', () => {
  const run = (cmd: ReturnType<typeof createSiwcCommand>, rawInput: string) =>
    cmd.handler({ rawInput, signal: new AbortController().signal } as never)

  it('status reports state without secrets; logout revokes and clears tokens but keeps registration', async () => {
    await signIn(h, mock)
    const session = parseSession(await h.ctx.credentials.readRecord(SESSION_KEY))!
    const cmd = createSiwcCommand(h.session, h.adapter)

    const status = await run(cmd, 'status')
    expect(status.kind).toBe('success')
    expect(status.text).toContain(EMAIL)
    expect(status.text).toContain('Plan usage: enabled')
    for (const secret of [session.accessToken, session.refreshToken!, session.idToken, ISSUED_CLIENT_ID]) {
      expect(status.text).not.toContain(secret)
    }

    const models = await run(cmd, 'models')
    expect(models.text).toContain('model-a — Model A')

    const out = await run(cmd, 'logout')
    expect(out.text).toMatch(/revoked/)
    expect(mock.revoked).toEqual([session.refreshToken])
    expect(await h.ctx.credentials.readRecord(SESSION_KEY)).toBeUndefined()
    expect(parseRegistry(await h.ctx.credentials.readRecord(REGISTRY_KEY))!.registrations).toHaveLength(1)

    const file = await readFile(h.credentialsPath, 'utf8')
    expect(file).not.toContain(session.accessToken)
    expect(file).not.toContain(session.refreshToken!)
  })

  it('logout tells the user when remote revocation was not confirmed', async () => {
    await signIn(h, mock)
    const cmd = createSiwcCommand(h.session, h.adapter)
    await mock.stop()
    const out = await run(cmd, 'logout')
    expect(out.text).toMatch(/NOT confirmed/)
    expect(await h.ctx.credentials.readRecord(SESSION_KEY)).toBeUndefined()
    mock = await new MockOpenAI().start()
  })
})

describe('plugin lifecycle', () => {
  it('registers the provider and flow, and removes both on dispose', async () => {
    expect(h.ctx.llm.listProviders().map((p) => p.id)).toContain('openai-siwc')
    expect(h.ctx.authorization.describe(SESSION_KEY)?.methods[0]?.label).toBe('Continue with ChatGPT')
    await h.ctx.fiber.dispose()
  })
})

describe('/siwc login (DSH 0.2.1 has no generic sign-in UI)', () => {
  const run = (cmd: ReturnType<typeof createSiwcCommand>, rawInput: string, signal = new AbortController().signal) =>
    cmd.handler({ rawInput, signal } as never)
  const loginCommand = (openBrowser: (url: string) => Promise<void>) =>
    createSiwcCommand(h.session, h.adapter, { authorization: () => h.ctx.authorization, openBrowser, authorizeUrl: mock.endpoints.authorize })

  it('opens the browser with the authorize URL and reports the signed-in account without leaking the URL', async () => {
    const opened: string[] = []
    const cmd = loginCommand(async (url) => {
      opened.push(url)
      void mock.completeBrowserSignIn(url)
    })
    const result = await run(cmd, 'login')
    expect(result.kind).toBe('success')
    expect(result.text).toContain(`Signed in to ChatGPT as ${EMAIL}`)
    expect(result.text).toContain('chatgpt.com/settings/usage')
    expect(opened).toHaveLength(1)
    expect(new URL(opened[0]!).searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(result.text).not.toContain(new URL(opened[0]!).searchParams.get('state')!)
    const session = parseSession(await h.ctx.credentials.readRecord(SESSION_KEY))!
    expect(result.text).not.toContain(session.accessToken)
  })

  it('reuses the saved account by default and registers another with "login new"', async () => {
    const cmd = loginCommand(async (url) => void mock.completeBrowserSignIn(url))
    await run(cmd, 'login')
    await run(cmd, 'login')
    expect(mock.authorizeRequests[1]!.get('client_id')).toBe(ISSUED_CLIENT_ID)
    await run(cmd, 'login new')
    expect(mock.authorizeRequests[2]!.get('client_id')).toBe('dynamic_agent_client')
  })

  it('stops cleanly when the browser cannot be opened', async () => {
    const cmd = loginCommand(async () => {
      throw new Error('no browser')
    })
    const result = await run(cmd, 'login')
    expect(result.text).toMatch(/Could not open the system browser/)
    expect(await h.ctx.credentials.readRecord(SESSION_KEY)).toBeUndefined()
    expect(h.ctx.authorization.describe(SESSION_KEY)?.inFlight).toBe(false)
  })

  it('withdraws the attempt when the command is cancelled', async () => {
    const controller = new AbortController()
    const cmd = loginCommand(async () => {
      controller.abort()
    })
    const result = await run(cmd, 'login', controller.signal)
    expect(result.text).toBe('Sign-in cancelled.')
    expect(h.ctx.authorization.describe(SESSION_KEY)?.inFlight).toBe(false)
  })
})

describe('model capabilities from the account catalog', () => {
  beforeEach(async () => {
    await signIn(h, mock)
  })

  it('advertises catalog input modalities and description', async () => {
    const models = await h.ctx.llm.listModels('openai-siwc')
    expect(models.map((m) => [m.id, m.inputModalities])).toEqual([['model-a', ['text', 'image']], ['model-b', ['text']]])
    expect(models[0]!.description).toBe('Vision and reasoning')
  })

  it('resolves context and API-accepted efforts only (drops client-only ultra), imposing no default', async () => {
    const info = await h.ctx.llm.resolveModelInfo('openai-siwc', 'model-a')
    expect(info.context).toEqual({ contextWindow: 500000 })
    expect(info.reasoning?.efforts.map((e) => e.id)).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
    expect(info.reasoning?.efforts[2]).toEqual({ id: 'high', name: 'High', description: 'Deep' })
    expect(info.reasoning?.defaultEffort).toBeUndefined()
    const textOnly = await h.ctx.llm.resolveModelInfo('openai-siwc', 'model-b')
    expect(textOnly.reasoning).toBeUndefined()
    expect(textOnly.inputModalities).toEqual(['text'])
  })

  it('sends a selected effort as reasoning.effort', async () => {
    await collect(h.ctx.llm.stream({ ...ask('x'), reasoningEffort: 'high' as never }))
    expect(mock.responsesBodies[0]!.reasoning).toEqual({ effort: 'high' })
  })

  it('lets DSH refuse an effort the model does not offer (client-only ultra) before any request', async () => {
    const finish = (await collect(h.ctx.llm.stream({ ...ask('x'), reasoningEffort: 'ultra' as never }))).at(-1)!
    expect(finish).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(mock.responsesBodies).toHaveLength(0)
  })

  it('answers conservatively (text-only, no efforts) while signed out', async () => {
    await createSiwcCommand(h.session, h.adapter).handler({ rawInput: 'logout', signal: new AbortController().signal } as never)
    const info = await h.ctx.llm.resolveModelInfo('openai-siwc', 'model-a')
    expect(info.inputModalities).toEqual(['text'])
    expect(info.reasoning).toBeUndefined()
  })

  it('omits reasoning when no effort is selected', async () => {
    await collect(h.ctx.llm.stream(ask('x')))
    expect(mock.responsesBodies[0]).not.toHaveProperty('reasoning')
  })
})

describe('image input', () => {
  const saveRed = () => h.ctx.attachments.saveImage({ data: solidPng(32, 32, [220, 20, 20]), mediaType: 'image/png', name: 'red.png' })
  const withImage = async (model: string) => {
    const ref = await saveRed()
    return { ref, options: { provider: 'openai-siwc', model, messages: [createUserMessage({ content: [{ type: 'text', text: 'What color?' }, { type: 'image', attachment: ref }], source: { kind: 'user' } })] } }
  }

  beforeEach(async () => {
    await signIn(h, mock)
  })

  it('sends a handle line and an inline data-URL image on an image-capable model', async () => {
    const { ref, options } = await withImage('model-a')
    expect((await collect(h.ctx.llm.stream(options))).at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    const content = (mock.responsesBodies[0]!.input as { content: { type: string; text?: string; image_url?: string; detail?: string }[] }[])[0]!.content
    expect(content.map((p) => p.type)).toEqual(['input_text', 'input_image'])
    expect(content[0]!.text).toContain('What color?')
    expect(content[0]!.text).toContain(ref.attachmentId)
    expect(content[1]!.detail).toBe('auto')
    const [, mediaType, data] = /^data:(image\/[a-z]+);base64,(.+)$/.exec(content[1]!.image_url!)!
    const version = await h.ctx.attachments.readImageRequest(ref, { width: ref.width, height: ref.height, maxBytes: Number.MAX_SAFE_INTEGER })
    expect(mediaType).toBe(version.mediaType)
    expect(Buffer.from(data!, 'base64').equals(Buffer.from(version.data))).toBe(true)
  })

  it('sends text placeholders, not image bytes, on a text-only model', async () => {
    const { options } = await withImage('model-b')
    await collect(h.ctx.llm.stream(options))
    expect(JSON.stringify(mock.responsesBodies[0]!.input)).not.toContain('input_image')
  })

  it('sends tool-result images as a typed function_call_output array', async () => {
    const ref = await saveRed()
    const call = { type: 'tool-call', id: 'call_1', name: 'screenshot', arguments: '{}' }
    const assistant = { id: 'm2', role: 'assistant', content: [call], source: { kind: 'model', provider: 'openai-siwc', model: 'model-a' } } as never
    const result = createToolResultMessage({ callId: 'call_1' as ToolCallId, content: [{ type: 'text', text: 'shot:' }, { type: 'image', attachment: ref }], isError: false })
    await collect(h.ctx.llm.stream({ ...ask('take one'), messages: [...ask('take one').messages, assistant, result] }))
    const output = (mock.responsesBodies[0]!.input as { type: string; output?: unknown }[]).find((i) => i.type === 'function_call_output')!.output as { type: string }[]
    expect(output.map((p) => p.type)).toEqual(['input_text', 'input_image'])
  })

  it('asks DSH to offload older images when the request exceeds the image budget', async () => {
    await h.dispose()
    h = await mountHarness(mock, { maxRequestImageBytes: 10 })
    await signIn(h, mock)
    const { options } = await withImage('model-a')
    const finish = (await collect(h.ctx.llm.stream(options))).at(-1)!
    expect(finish).toMatchObject({ reason: { kind: 'error', failure: { code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 1 } } })
    expect(mock.responsesBodies).toHaveLength(0)
  })

  it('replaces an offloaded image with the DSH recovery placeholder', async () => {
    const ref = await saveRed()
    const message = createUserMessage({ content: [{ type: 'image', attachment: ref, offloaded: true }], source: { kind: 'user' } })
    await collect(h.ctx.llm.stream({ provider: 'openai-siwc', model: 'model-a', messages: [message] }))
    const body = JSON.stringify(mock.responsesBodies[0]!.input)
    expect(body).not.toContain('input_image')
    expect(body).toContain(ref.attachmentId)
  })
})
