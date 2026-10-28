/**
 * The DSH `LlmAdapter` for ChatGPT plan usage: model catalog from the signed-in
 * account's `/v1/models`, and streaming inference through `/v1/responses`.
 */
import type { Logger } from '@deepseek-ai/cordis'
import type { AttachmentStore, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import {
  IMAGE_OFFLOAD_REQUIRED_CODE,
  LlmAdapter,
  LlmError,
  attributionHeaders,
  requiredImageOffload,
  type GenerateOptions,
  type LlmModelInfo,
  type LlmProviderInfo,
  type LlmReasoningEffortInfo,
  type LlmResolvedModelInfo,
  type ModelModality,
  type ReasoningEffortId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { providerError, requestIdOf, retryAfterMs } from './errors.ts'
import type { SiwcEndpoints } from './protocol.ts'
import { redact } from './redact.ts'
import {
  buildResponsesBody,
  projectRequest,
  retainedImages,
  translateStream,
  type ProjectedRequest,
  type RequestImages,
} from './responses.ts'
import type { SiwcSession } from './session.ts'

export const PROVIDER = 'openai-siwc'
export const PROVIDER_NAME = 'ChatGPT plan (Sign in with ChatGPT)'

export interface AdapterConfig {
  /** Context window for a model whose catalog entry discloses none. */
  defaultContextWindow: number
  /** Per-model overrides keyed by model slug. */
  models: Record<string, { contextWindow?: number }>
  streamIdleTimeoutMs: number
  /** Base64 image bytes one request may carry before older images must be offloaded. */
  maxRequestImageBytes: number
}

/**
 * Effort values the Responses API documents for `reasoning.effort`. The account
 * catalog may list client-only levels (observed: `ultra`), which the API rejects.
 */
export const API_REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

export interface CatalogModel {
  slug: string
  displayName: string
  description?: string
  /** `text`/`image` from the entry's `input_modalities`; text alone when undisclosed. */
  inputModalities: ModelModality[]
  contextWindow?: number
  /** Catalog levels the API accepts, in catalog order (least to greatest). */
  efforts: LlmReasoningEffortInfo[]
}

interface CatalogCache {
  /** clientId + subject the catalog belongs to; a different account invalidates it. */
  owner: string
  models: CatalogModel[]
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * Keep `visibility: "list"` entries in server order (models-and-inference §1)
 * and read the capability fields the live catalog carries (observed
 * 2026-10-28; undocumented, so every field is optional and validated).
 */
export function parseModelList(json: unknown): CatalogModel[] {
  const models = (json as { models?: unknown })?.models
  if (!Array.isArray(models)) throw new LlmError('Model list response had no models array', 'SIWC_MALFORMED_RESPONSE')
  const out: CatalogModel[] = []
  for (const entry of models) {
    const m = entry as Record<string, unknown>
    if (m?.visibility !== 'list' || typeof m.slug !== 'string' || !m.slug) continue
    const modalities = Array.isArray(m.input_modalities)
      ? m.input_modalities.filter((x): x is ModelModality => x === 'text' || x === 'image')
      : []
    const efforts: LlmReasoningEffortInfo[] = []
    for (const level of Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []) {
      const effort = (level as { effort?: unknown })?.effort
      if (typeof effort !== 'string' || !API_REASONING_EFFORTS.has(effort) || efforts.some((e) => e.id === effort)) continue
      const description = (level as { description?: unknown }).description
      efforts.push({
        id: effort as ReasoningEffortId,
        name: capitalize(effort),
        ...(typeof description === 'string' && description ? { description } : {}),
      })
    }
    out.push({
      slug: m.slug,
      displayName: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug,
      ...(typeof m.description === 'string' && m.description ? { description: m.description } : {}),
      inputModalities: modalities.includes('text') ? modalities : ['text', ...modalities],
      ...(typeof m.context_window === 'number' && Number.isSafeInteger(m.context_window) && m.context_window > 0
        ? { contextWindow: m.context_window }
        : {}),
      efforts,
    })
  }
  return out
}

async function errorFromResponse(res: Response): Promise<LlmError> {
  const requestId = requestIdOf(res.headers)
  let errorCode: string | undefined
  let param: string | undefined
  let detail: string | undefined
  try {
    const json = (await res.json()) as { error?: { code?: unknown; param?: unknown; message?: unknown }; detail?: unknown }
    if (json.error && typeof json.error === 'object') {
      errorCode = typeof json.error.code === 'string' ? json.error.code : undefined
      param = typeof json.error.param === 'string' ? json.error.param : undefined
      detail = typeof json.error.message === 'string' ? json.error.message : undefined
    } else if (typeof json.detail === 'string') {
      detail = json.detail
    }
  } catch {}
  return providerError({ status: res.status, errorCode, param, detail, requestId, retryAfterMs: retryAfterMs(res.headers.get('retry-after')) })
}

export class SiwcAdapter extends LlmAdapter {
  private catalog: CatalogCache | undefined
  private warnedMaxTokens = false
  /** Last catalog failure, surfaced by diagnostics. */
  lastCatalogError: string | undefined

  constructor(
    private readonly session: SiwcSession,
    private readonly endpoints: SiwcEndpoints,
    private readonly config: AdapterConfig,
    private readonly logger: Logger,
    /** The DSH attachment store, when the composition mounts one. */
    private readonly attachments: () => AttachmentStore | undefined = () => undefined,
  ) {
    super()
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: PROVIDER_NAME }
  }

  invalidateCatalog() {
    this.catalog = undefined
  }

  private async send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const token = await this.session.accessToken(signal)
    try {
      return await fetch(url, {
        ...init,
        headers: { ...attributionHeaders(), ...(init.headers as Record<string, string>), authorization: `Bearer ${token}` },
        signal,
        redirect: 'error',
      })
    } catch (cause) {
      if (signal?.aborted) throw cause
      throw new LlmError(`Could not reach OpenAI (${redact(String(cause))})`, 'TRANSPORT')
    }
  }

  /**
   * Fetch the signed-in account's catalog, cached per account.
   * @throws LlmError when not signed in or the request fails.
   */
  async fetchCatalog(signal?: AbortSignal): Promise<CatalogModel[]> {
    const current = await this.session.current()
    const owner = current ? `${current.clientId}:${current.subject}` : ''
    if (this.catalog && this.catalog.owner === owner) return this.catalog.models
    const res = await this.send(`${this.endpoints.apiBase}/models`, { headers: { accept: 'application/json' } }, signal)
    if (!res.ok) throw await errorFromResponse(res)
    const models = parseModelList(await res.json())
    this.catalog = { owner, models }
    this.lastCatalogError = undefined
    return models
  }

  /**
   * One model's catalog entry, fetching the catalog if needed. Signed out it is
   * undefined (conservative text-only info); any other failure — a refused or
   * failed refresh, a network error — belongs to the request being prepared.
   */
  private async catalogModel(model: string, signal?: AbortSignal): Promise<CatalogModel | undefined> {
    try {
      return (await this.fetchCatalog(signal)).find((m) => m.slug === model)
    } catch (error) {
      if (error instanceof LlmError && error.code === 'MISSING_CREDENTIAL') return undefined
      throw error
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    try {
      return (await this.fetchCatalog()).map((m) => ({
        provider,
        id: m.slug,
        name: m.displayName,
        ...(m.description ? { description: m.description } : {}),
        inputModalities: m.inputModalities,
      }))
    } catch (error) {
      // Selectors must keep working while signed out; the reason stays visible in /siwc status.
      this.lastCatalogError = error instanceof Error ? redact(error.message) : 'unknown error'
      this.logger.debug('model catalog unavailable: %s', this.lastCatalogError)
      return []
    }
  }

  /**
   * Capabilities come only from the account catalog; an unknown model is
   * treated as text-only with no selectable effort rather than guessed at.
   * No default effort is imposed, so the provider's own default applies
   * (observed to differ from the catalog's `default_reasoning_level`).
   */
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted()
    const known = await this.catalogModel(model, signal)
    return {
      provider,
      id: model,
      name: known?.displayName ?? model,
      ...(known?.description ? { description: known.description } : {}),
      inputModalities: known?.inputModalities ?? ['text'],
      context: {
        contextWindow: this.config.models[model]?.contextWindow ?? known?.contextWindow ?? this.config.defaultContextWindow,
      },
      ...(known?.efforts.length ? { reasoning: { efforts: known.efforts } } : {}),
    }
  }

  /**
   * Read the route-sized request version of every retained image, then apply
   * the request budget through DSH's offload contract: when the images do not
   * fit, fail with `IMAGE_OFFLOAD_REQUIRED` so DSH offloads the oldest ones and
   * retries, instead of sending a request the server may reject.
   */
  private async prepareImages(options: GenerateOptions, projected: ProjectedRequest): Promise<RequestImages> {
    const blocks = retainedImages(projected.messages)
    const versions = new Map<string, RequestImageAttachment>()
    if (!blocks.length) return versions
    const store = this.attachments()
    if (!store) throw new LlmError('Image input needs the DSH attachment store, which this composition does not mount', 'UNSUPPORTED_PARAMETER')
    const unique = [...new Map(blocks.map((b) => [b.attachment.attachmentId as string, b.attachment])).values()]
    const read = await Promise.all(unique.map((ref) =>
      store.readImageRequest(ref, this.imageRequestTarget(options.provider, options.model, ref), options.signal)))
    for (const version of read) versions.set(version.attachment.attachmentId, version)
    const offload = requiredImageOffload(
      projected.messages,
      { representation: 'base64', maxBytes: this.config.maxRequestImageBytes },
      (block) => versions.get(block.attachment.attachmentId)!.bytes,
    )
    if (offload > 0) {
      throw new LlmError(
        `The request carries more image data than this route accepts; ${offload} older image(s) must be offloaded`,
        IMAGE_OFFLOAD_REQUIRED_CODE,
        { offloadImages: offload },
      )
    }
    return versions
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const projected = projectRequest(options)
    // Unlike the selector paths, a request surfaces catalog failures (sign-in, refresh, network)
    // as its own error instead of silently degrading to a text-only projection.
    const model = (await this.fetchCatalog(options.signal)).find((m) => m.slug === options.model)
    const images = model?.inputModalities.includes('image') ? await this.prepareImages(options, projected) : undefined
    const body = buildResponsesBody(options, projected, images)
    if (options.maxTokens !== undefined && !this.warnedMaxTokens) {
      this.warnedMaxTokens = true
      this.logger.info('maxTokens is not sent: ChatGPT plan usage does not accept max_output_tokens')
    }
    const res = await this.send(`${this.endpoints.apiBase}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
    }, options.signal)
    if (!res.ok) throw await errorFromResponse(res)
    const requestId = requestIdOf(res.headers)
    // The live endpoint streams SSE without any Content-Type, so only an explicit non-SSE
    // type is refused; the parser and the response.completed rule guard everything else.
    const contentType = res.headers.get('content-type')
    if (!res.body || (contentType && !contentType.includes('text/event-stream'))) {
      await res.body?.cancel()
      throw providerError({ status: res.status, detail: `expected an event stream, got ${contentType ?? 'no body'}`, requestId })
    }
    yield* translateStream(res.body, requestId, this.config.streamIdleTimeoutMs)
  }
}
