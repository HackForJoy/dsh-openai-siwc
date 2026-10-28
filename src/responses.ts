/**
 * Translation between the DSH request/stream vocabulary and the Responses API
 * as constrained by ChatGPT plan usage: `store:false`, `stream:true`, full
 * history in `input`, system prompt in `instructions`, tools grouped in one
 * namespace, and none of the fields the preview forbids.
 */
import { createParser } from 'eventsource-parser'
import type { RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import {
  EMPTY_RESPONSE_CODE,
  LlmError,
  offloadedImageText,
  projectImagesForTextModel,
  projectToolUpdates,
  requestImageHandleText,
  type ContentBlock,
  type GenerateOptions,
  type ImageBlock,
  type ProviderRequestId,
  type RequestMessage,
  type StreamChunk,
  type TokenUsage,
  type ToolCallId,
  type ToolSchema,
} from '@deepseek-ai/dsh-llm'
import { providerError } from './errors.ts'

/** Namespace every DSH tool is declared under. */
export const TOOL_NAMESPACE = 'dsh'
const NAMESPACE_DESCRIPTION = 'Tools provided by the DeepSeek Harness agent runtime.'

type InputItem = Record<string, unknown>
type InputPart = { type: 'input_text'; text: string } | { type: 'input_image'; image_url: string; detail: 'auto' }

export interface ResponsesBody {
  model: string
  instructions?: string
  input: InputItem[]
  tools?: Record<string, unknown>[]
  reasoning?: { effort: string }
  store: false
  stream: true
}

/** Request versions of the retained images of one request, keyed by attachment id. */
export type RequestImages = ReadonlyMap<string, RequestImageAttachment>

export interface ProjectedRequest {
  messages: readonly RequestMessage[]
  tools: readonly ToolSchema[] | undefined
}

function unsupported(message: string): LlmError {
  return new LlmError(message, 'UNSUPPORTED_PARAMETER')
}

/** Current tool declarations and the history this route receives (no tool-update messages). */
export function projectRequest(options: GenerateOptions): ProjectedRequest {
  return projectToolUpdates(options.messages, options.tools, undefined, options.toolHistory)
}

/** Image blocks a request will send as images (not offloaded), in request order. */
export function retainedImages(messages: readonly RequestMessage[]): ImageBlock[] {
  const out: ImageBlock[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'tool') continue
    for (const block of message.content) if (block.type === 'image' && !block.offloaded) out.push(block)
  }
  return out
}

/** Collapse content to text; anything that cannot be text is refused, not dropped. */
function textOf(content: readonly ContentBlock[], where: string): string {
  return contentParts(content, where, undefined).map((p) => (p.type === 'input_text' ? p.text : '')).join('')
}

/**
 * Typed input parts for user or tool content. Images become the DSH handle
 * text plus an inline data-URL image (the Files API is not available on this
 * route); offloaded images become DSH's recovery placeholder.
 */
function contentParts(content: readonly ContentBlock[], where: string, images: RequestImages | undefined): InputPart[] {
  const parts: InputPart[] = []
  const text = (t: string) => {
    const last = parts.at(-1)
    if (last?.type === 'input_text') last.text += t
    else parts.push({ type: 'input_text', text: t })
  }
  for (const block of content) {
    switch (block.type) {
      case 'text':
        text(block.text)
        break
      case 'tool-addition':
      case 'tool-removal':
        // Already folded into the tool declarations by projectToolUpdates.
        break
      case 'image': {
        if (!images) throw unsupported(`openai-siwc cannot send image content in ${where}`)
        if (block.offloaded) {
          text(offloadedImageText(block.attachment))
          break
        }
        const version = images.get(block.attachment.attachmentId)
        if (!version) throw new LlmError(`openai-siwc: no request version prepared for an image in ${where}`, 'INVARIANT')
        text(requestImageHandleText(block.attachment, version))
        parts.push({
          type: 'input_image',
          image_url: `data:${version.mediaType};base64,${Buffer.from(version.data).toString('base64')}`,
          detail: 'auto',
        })
        break
      }
      default:
        throw unsupported(`openai-siwc cannot send ${block.type} content in ${where}`)
    }
  }
  return parts
}

/**
 * Build the Responses request body for one DSH request.
 * @param images - prepared request versions on an image-capable route; omitted, images become text placeholders.
 * @throws LlmError `UNSUPPORTED_PARAMETER` for controls ChatGPT plan usage rejects.
 */
export function buildResponsesBody(
  options: GenerateOptions,
  projected: ProjectedRequest = projectRequest(options),
  images?: RequestImages,
): ResponsesBody {
  if (options.temperature !== undefined) {
    throw unsupported('ChatGPT plan usage does not accept temperature; remove it for the openai-siwc provider')
  }
  if (options.stop?.length) {
    throw unsupported('The Responses API used by ChatGPT plan usage has no stop sequences; remove them for the openai-siwc provider')
  }

  const messages = images ? projected.messages : projectImagesForTextModel(projected.messages)

  const instructions: string[] = []
  if (options.system) instructions.push(options.system)
  const input: InputItem[] = []
  let leading = true

  for (const message of messages) {
    if (message.role === 'system' && leading) {
      instructions.push(textOf(message.content, 'the system prompt'))
      continue
    }
    leading = false
    switch (message.role) {
      case 'system':
      case 'developer': {
        // Responses rejects system-role items; a later system prompt rides as developer text.
        const text = textOf(message.content, 'a developer message')
        if (text) input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] })
        break
      }
      case 'user': {
        const parts = contentParts(message.content, 'a user message', images)
        input.push({ type: 'message', role: 'user', content: parts.length ? parts : [{ type: 'input_text', text: '' }] })
        break
      }
      case 'assistant': {
        let text = ''
        const flush = () => {
          if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
          text = ''
        }
        for (const block of message.content) {
          if (block.type === 'text') text += block.text
          else if (block.type === 'reasoning') continue // not replayable with store:false
          else if (block.type === 'tool-call') {
            flush()
            input.push({ type: 'function_call', call_id: block.id, name: block.name, arguments: block.arguments, namespace: TOOL_NAMESPACE })
          } else throw unsupported(`openai-siwc cannot replay ${block.type} content in an assistant message`)
        }
        flush()
        break
      }
      case 'tool': {
        const parts = contentParts(message.content, 'a tool result', images)
        const output = parts.some((p) => p.type === 'input_image')
          ? parts
          : parts.map((p) => (p.type === 'input_text' ? p.text : '')).join('')
        input.push({ type: 'function_call_output', call_id: message.toolCallId, output })
        break
      }
      default:
        throw unsupported(`openai-siwc cannot send messages with role ${(message as { role: string }).role}`)
    }
  }

  const body: ResponsesBody = { model: options.model, input, store: false, stream: true }
  if (instructions.length) body.instructions = instructions.join('\n\n')
  if (options.reasoningEffort !== undefined) body.reasoning = { effort: options.reasoningEffort }
  if (projected.tools?.length) {
    body.tools = [{
      type: 'namespace',
      name: TOOL_NAMESPACE,
      description: NAMESPACE_DESCRIPTION,
      tools: projected.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters })),
    }]
  }
  return body
}

// ---------------------------------------------------------------- stream

interface OpenBlock {
  index: number
  kind: 'text' | 'reasoning' | 'tool-call'
  text: string
  callId?: string
  name?: string
}

interface ResponseEvent {
  type: string
  [key: string]: unknown
}

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export function usageFrom(raw: unknown): TokenUsage | undefined {
  const u = obj(raw)
  const input = num(u.input_tokens)
  const output = num(u.output_tokens)
  if (input === undefined || output === undefined) return undefined
  const cached = num(obj(u.input_tokens_details).cached_tokens) ?? 0
  const usage: TokenUsage = { inputTokens: Math.max(0, input - cached), outputTokens: output }
  if (cached) usage.cacheReadTokens = cached
  const reasoning = num(obj(u.output_tokens_details).reasoning_tokens)
  if (reasoning) usage.reasoningTokens = reasoning
  const total = num(u.total_tokens)
  if (total !== undefined) usage.totalTokens = total
  return usage
}

/** Translates Responses SSE events into DSH chunks; holds per-response block state. */
export class ResponsesStreamTranslator {
  private readonly blocks = new Map<string, OpenBlock>()
  private nextIndex = 0
  private sawToolCall = false
  private emitted = 0
  /** Set once a terminal event has been handled. */
  done = false

  constructor(private readonly requestId?: string) {}

  private open(key: string, kind: OpenBlock['kind'], out: StreamChunk[], extra: Partial<OpenBlock> = {}): OpenBlock {
    let block = this.blocks.get(key)
    if (!block) {
      block = { index: this.nextIndex++, kind, text: '', ...extra }
      this.blocks.set(key, block)
      out.push({ type: 'block-start', index: block.index, blockType: kind })
    }
    return block
  }

  private close(key: string, out: StreamChunk[], finalText?: string) {
    const block = this.blocks.get(key)
    if (!block) return
    this.blocks.delete(key)
    const text = finalText ?? block.text
    this.emitted++
    if (block.kind === 'tool-call') {
      this.sawToolCall = true
      out.push({
        type: 'block-end',
        index: block.index,
        block: { type: 'tool-call', id: block.callId as ToolCallId, name: block.name ?? '', arguments: text },
      })
    } else {
      out.push({ type: 'block-end', index: block.index, block: { type: block.kind, text } })
    }
  }

  private closeAll(out: StreamChunk[]) {
    for (const key of [...this.blocks.keys()]) this.close(key, out)
  }

  /** Handle one event; returns the chunks to emit, or throws the terminal failure. */
  handle(event: ResponseEvent): StreamChunk[] {
    const out: StreamChunk[] = []
    const itemKey = (prefix: string) => `${prefix}:${str(event.item_id) ?? ''}:${num(event.content_index) ?? num(event.summary_index) ?? 0}`
    switch (event.type) {
      case 'response.output_text.delta':
      case 'response.refusal.delta': {
        const block = this.open(itemKey('t'), 'text', out)
        const delta = str(event.delta) ?? ''
        block.text += delta
        if (delta) out.push({ type: 'text-delta', index: block.index, text: delta })
        break
      }
      case 'response.output_text.done':
      case 'response.refusal.done':
        this.close(itemKey('t'), out, str(event.text) ?? str(event.refusal))
        break
      case 'response.reasoning_summary_text.delta': {
        const block = this.open(itemKey('r'), 'reasoning', out)
        const delta = str(event.delta) ?? ''
        block.text += delta
        if (delta) out.push({ type: 'reasoning-delta', index: block.index, text: delta })
        break
      }
      case 'response.reasoning_summary_text.done':
        this.close(itemKey('r'), out, str(event.text))
        break
      case 'response.output_item.added': {
        const item = obj(event.item)
        if (item.type !== 'function_call') break
        const callId = str(item.call_id)
        const name = str(item.name)
        if (!callId || !name) throw providerError({ detail: 'function_call item without call_id or name', requestId: this.requestId })
        const block = this.open(`f:${str(item.id) ?? callId}`, 'tool-call', out, { callId, name })
        out.push({ type: 'tool-call-delta', index: block.index, id: callId as ToolCallId, name, argumentsDelta: '' })
        break
      }
      case 'response.function_call_arguments.delta': {
        const block = this.blocks.get(`f:${str(event.item_id) ?? ''}`)
        const delta = str(event.delta) ?? ''
        if (!block || !delta) break
        block.text += delta
        out.push({ type: 'tool-call-delta', index: block.index, id: block.callId as ToolCallId, argumentsDelta: delta })
        break
      }
      case 'response.output_item.done': {
        const item = obj(event.item)
        if (item.type === 'function_call') {
          this.close(`f:${str(item.id) ?? str(item.call_id) ?? ''}`, out, str(item.arguments))
        }
        break
      }
      case 'response.completed': {
        this.done = true
        this.closeAll(out)
        if (this.emitted === 0) {
          throw new LlmError('ChatGPT plan request completed without any content', EMPTY_RESPONSE_CODE)
        }
        const usage = usageFrom(obj(event.response).usage)
        if (usage) out.push({ type: 'usage', usage })
        out.push({ type: 'finish', reason: this.sawToolCall ? { kind: 'tool-calls' } : { kind: 'stop' } })
        break
      }
      case 'response.incomplete': {
        this.done = true
        const response = obj(event.response)
        const reason = str(obj(response.incomplete_details).reason) ?? 'unknown'
        if (reason !== 'max_output_tokens') {
          throw providerError({ errorCode: `incomplete:${reason}`, detail: 'The response ended incomplete.', requestId: this.requestId })
        }
        this.closeAll(out)
        const usage = usageFrom(response.usage)
        if (usage) out.push({ type: 'usage', usage })
        out.push({ type: 'finish', reason: { kind: 'max-tokens' } })
        break
      }
      case 'response.failed': {
        this.done = true
        const error = obj(obj(event.response).error)
        throw providerError({ errorCode: str(error.code), param: str(error.param), detail: str(error.message), requestId: this.requestId })
      }
      case 'error': {
        this.done = true
        throw providerError({ errorCode: str(event.code), param: str(event.param), detail: str(event.message), requestId: this.requestId })
      }
    }
    return out
  }
}

/**
 * Read an SSE body to its terminal event.
 * @param idleTimeoutMs - longest silence tolerated while waiting for the next bytes.
 */
export async function* translateStream(
  body: ReadableStream<Uint8Array>,
  requestId: string | undefined,
  idleTimeoutMs: number,
): AsyncGenerator<StreamChunk> {
  const translator = new ResponsesStreamTranslator(requestId)
  const pending: ResponseEvent[] = []
  let malformed = false
  const parser = createParser({
    onEvent(message) {
      try {
        const parsed: unknown = JSON.parse(message.data)
        if (typeof parsed === 'object' && parsed !== null && typeof (parsed as ResponseEvent).type === 'string') {
          pending.push(parsed as ResponseEvent)
        }
      } catch {
        malformed = true
      }
    },
  })
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    while (!translator.done) {
      let timer: NodeJS.Timeout | undefined
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new LlmError(`No data from OpenAI for ${Math.round(idleTimeoutMs / 1000)}s`, 'TIMEOUT')),
          idleTimeoutMs,
        )
      })
      let read: Awaited<ReturnType<typeof reader.read>>
      try {
        read = await Promise.race([reader.read(), idle])
      } finally {
        clearTimeout(timer)
      }
      if (read.done) break
      parser.feed(decoder.decode(read.value, { stream: true }))
      if (malformed) throw providerError({ detail: 'malformed stream event', requestId })
      while (pending.length && !translator.done) {
        for (const chunk of translator.handle(pending.shift()!)) yield chunk
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
  if (!translator.done) {
    throw new LlmError('The ChatGPT plan stream ended before response.completed', 'TRANSPORT', {
      requestId: requestId as ProviderRequestId | undefined,
    })
  }
}
