import { describe, expect, it } from 'vitest'
import {
  createDeveloperMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
  type GenerateOptions,
  type StreamChunk,
  type ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { ResponsesStreamTranslator, buildResponsesBody, translateStream, usageFrom } from '../../src/responses.ts'
import { parseModelList } from '../../src/adapter.ts'
import { textEvents, toolCallEvents, type SseEvent } from '../helpers/mock-openai.ts'

const user = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const req = (over: Partial<GenerateOptions>): GenerateOptions => ({ provider: 'openai-siwc', model: 'm', messages: [user('hi')], ...over })

describe('buildResponsesBody', () => {
  it('always sets store:false and stream:true and nothing forbidden', () => {
    const body = buildResponsesBody(req({ maxTokens: 100 }))
    expect(body).toEqual({ model: 'm', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], store: false, stream: true })
  })

  it('moves the leading system prompt (and one-shot system) into instructions, never a system item', () => {
    const body = buildResponsesBody(req({ system: 'one-shot', messages: [createSystemMessage('You are DSH.'), user('hi')] }))
    expect(body.instructions).toBe('one-shot\n\nYou are DSH.')
    expect(JSON.stringify(body.input)).not.toContain('"role":"system"')
  })

  it('sends a later system message as developer role; DSH strips developer messages on routes without tool updates', () => {
    const body = buildResponsesBody(req({
      messages: [user('a'), createSystemMessage('new rules'), createDeveloperMessage({ content: [{ type: 'text', text: 'dev' }], source: { kind: 'user' } as never })],
    }))
    expect(body.input.slice(1)).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'new rules' }] },
    ])
  })

  it('replays assistant text and tool calls in order, skips reasoning, and sends tool output', () => {
    const assistant = {
      id: 'a', role: 'assistant', source: { kind: 'model', provider: 'openai-siwc', model: 'm' },
      content: [
        { type: 'reasoning', text: 'thinking' },
        { type: 'text', text: 'Let me check.' },
        { type: 'tool-call', id: 'call_9', name: 'ls', arguments: '{}' },
      ],
    } as never
    const result = createToolResultMessage({ callId: 'call_9' as ToolCallId, content: [{ type: 'text', text: 'a.txt' }], isError: true })
    const body = buildResponsesBody(req({ messages: [user('list'), assistant, result] }))
    expect(body.input.slice(1)).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Let me check.' }] },
      { type: 'function_call', call_id: 'call_9', name: 'ls', arguments: '{}', namespace: 'dsh' },
      { type: 'function_call_output', call_id: 'call_9', output: 'a.txt' },
    ])
  })

  it('maps a selected effort to reasoning.effort', () => {
    expect(buildResponsesBody(req({ reasoningEffort: 'xhigh' as never })).reasoning).toEqual({ effort: 'xhigh' })
  })

  it('refuses image content when no request versions were prepared (text-only projection replaces it first)', () => {
    const image = { type: 'image', attachment: { attachmentId: 'sha256:x', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } } as never
    const body = buildResponsesBody(req({ messages: [createUserMessage({ content: [image], source: { kind: 'user' } })] }))
    expect(JSON.stringify(body.input)).not.toContain('input_image')
  })

  it('groups tools in one namespace', () => {
    const body = buildResponsesBody(req({ tools: [{ name: 'ls', description: 'List', parameters: { type: 'object' } }] }))
    expect(body.tools).toEqual([{ type: 'namespace', name: 'dsh', description: expect.any(String), tools: [{ type: 'function', name: 'ls', description: 'List', parameters: { type: 'object' } }] }])
  })

  it.each([
    ['temperature', { temperature: 0 }],
    ['stop', { stop: ['END'] }],
  ])('refuses %s explicitly', (_, over) => {
    expect(() => buildResponsesBody(req(over))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_PARAMETER' }))
  })
})

describe('ResponsesStreamTranslator', () => {
  const run = (events: SseEvent[]) => {
    const t = new ResponsesStreamTranslator('req_1')
    return events.flatMap((e) => t.handle(e))
  }

  it('turns text deltas into one text block with usage and stop', () => {
    expect(run(textEvents('Hi!', { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 4 }, output_tokens_details: { reasoning_tokens: 1 } } as never))).toEqual([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'Hi' },
      { type: 'text-delta', index: 0, text: '!' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'Hi!' } },
      { type: 'usage', usage: { inputTokens: 6, outputTokens: 2, cacheReadTokens: 4, reasoningTokens: 1, totalTokens: 12 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
  })

  it('assembles a tool call using the final arguments and finishes with tool-calls', () => {
    const chunks = run(toolCallEvents('ls', '{"dir":"src"}'))
    expect(chunks.filter((c) => c.type === 'tool-call-delta').map((c) => (c as { argumentsDelta: string }).argumentsDelta).join('')).toBe('{"dir":"src"}')
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call_1', name: 'ls', arguments: '{"dir":"src"}' } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('maps response.incomplete for max_output_tokens to max-tokens and other reasons to errors', () => {
    const base = textEvents('cut').slice(0, 3)
    expect(run([...base, { type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]).at(-1))
      .toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(() => run([...base, { type: 'response.incomplete', response: { incomplete_details: { reason: 'content_filter' } } }]))
      .toThrow(/incomplete:content_filter/)
  })

  it('throws EMPTY_RESPONSE when completed carries no content', () => {
    expect(() => run([{ type: 'response.completed', response: {} }])).toThrow(expect.objectContaining({ code: 'EMPTY_RESPONSE' }))
  })

  it('maps response.failed and error events through the documented codes', () => {
    expect(() => run([{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_unavailable' } } }]))
      .toThrow(expect.objectContaining({ code: 'SERVER' }))
    expect(() => run([{ type: 'error', code: 'subscription_sharing_unsupported_capability', param: 'tools[0]', message: 'no' }]))
      .toThrow(expect.objectContaining({ code: 'SIWC_UNSUPPORTED_CAPABILITY', message: expect.stringContaining('param=tools[0]') }))
  })

  it('ignores unknown events', () => {
    expect(run([{ type: 'response.in_progress' }, { type: 'response.something_new' }])).toEqual([])
  })
})

describe('translateStream', () => {
  const sse = (events: SseEvent[], split = 7) => {
    const text = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('')
    const bytes = new TextEncoder().encode(text)
    return new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += split) c.enqueue(bytes.slice(i, i + split))
        c.close()
      },
    })
  }
  const collect = async (s: AsyncIterable<StreamChunk>) => {
    const out: StreamChunk[] = []
    for await (const c of s) out.push(c)
    return out
  }

  it('parses events split across arbitrary byte boundaries', async () => {
    const chunks = await collect(translateStream(sse(textEvents('héllo wörld'), 3), 'r', 1000))
    expect(chunks).toContainEqual({ type: 'block-end', index: 0, block: { type: 'text', text: 'héllo wörld' } })
  })

  it('fails a stream that ends without a terminal event', async () => {
    await expect(collect(translateStream(sse(textEvents('x').slice(0, 3)), 'r', 1000))).rejects.toMatchObject({ code: 'TRANSPORT' })
  })

  it('times out an idle stream', async () => {
    const stalled = new ReadableStream<Uint8Array>({ start() {} })
    await expect(collect(translateStream(stalled, 'r', 30))).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('rejects malformed event data', async () => {
    const bad = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {not json\n\n'))
        c.close()
      },
    })
    await expect(collect(translateStream(bad, 'r', 1000))).rejects.toThrow(/malformed stream event/)
  })
})

describe('model list and usage parsing', () => {
  it('keeps visibility=list models in order and falls back to slug for names', () => {
    expect(parseModelList({ models: [
      { slug: 'b', display_name: 'B', visibility: 'list' },
      { slug: 'x', visibility: 'hide' },
      { slug: 'a', visibility: 'list' },
      { display_name: 'no slug', visibility: 'list' },
    ] }).map((m) => [m.slug, m.displayName])).toEqual([['b', 'B'], ['a', 'a']])
  })

  it('reads catalog capabilities and keeps only API-accepted efforts', () => {
    const [m] = parseModelList({ models: [{
      slug: 'g', visibility: 'list', input_modalities: ['image', 'audio'], context_window: 272000,
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'ultra' }, { effort: 'max', description: 'Most' }, { effort: 'low' }, 'junk'],
    }] })
    expect(m).toEqual({
      slug: 'g', displayName: 'g', inputModalities: ['text', 'image'], contextWindow: 272000,
      efforts: [{ id: 'low', name: 'Low' }, { id: 'max', name: 'Max', description: 'Most' }],
    })
  })

  it('treats a model without capability fields as text-only with no efforts', () => {
    expect(parseModelList({ models: [{ slug: 'p', visibility: 'list' }] })).toEqual([{ slug: 'p', displayName: 'p', inputModalities: ['text'], efforts: [] }])
  })

  it('rejects an API-key style data[] list instead of guessing', () => {
    expect(() => parseModelList({ data: [{ id: 'gpt' }] })).toThrow(/no models array/)
  })

  it('returns no usage when counts are missing', () => {
    expect(usageFrom(undefined)).toBeUndefined()
    expect(usageFrom({ input_tokens: 1 })).toBeUndefined()
  })
})
