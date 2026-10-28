/**
 * Mapping from SIWC/Responses failures to DSH `LlmError` codes, following the
 * official errors-and-recovery page. Retryability is decided by DSH's default
 * retryable set (`RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`,
 * `EMPTY_RESPONSE`): transient conditions map into it, everything the docs say
 * must not be repeated maps outside it. Messages carry codes, status, request
 * id and official guidance — never a response body verbatim.
 */
import { CONTEXT_WINDOW_EXCEEDED_CODE, LlmError, QUOTA_EXCEEDED_CODE, isContextWindowExceededError } from '@deepseek-ai/dsh-llm'
import type { ProviderRequestId } from '@deepseek-ai/dsh-llm'
import { USAGE_SETTINGS_URL } from './protocol.ts'
import { redact } from './redact.ts'

export const SIGN_IN_HINT = 'Sign in again with "/siwc login" (Continue with ChatGPT).'

interface Mapping {
  code: string
  advice: string
}

/** Structured Responses `error.code` values documented for ChatGPT plan usage. */
const STRUCTURED: Record<string, Mapping> = {
  subscription_sharing_user_not_eligible: {
    code: 'SIWC_NOT_ELIGIBLE',
    advice: 'ChatGPT plan usage is not available for this user, workspace, or policy.',
  },
  subscription_sharing_usage_limit_exceeded: {
    code: QUOTA_EXCEEDED_CODE,
    advice: `ChatGPT plan usage limit reached for this app. Review usage at ${USAGE_SETTINGS_URL}.`,
  },
  subscription_sharing_usage_unavailable: {
    code: 'SERVER',
    advice: 'Usage could not be checked right now; retry later.',
  },
  subscription_sharing_unsupported_capability: {
    code: 'SIWC_UNSUPPORTED_CAPABILITY',
    advice: 'The request used an input, tool, model, or option that ChatGPT plan usage does not support.',
  },
  subscription_sharing_route_not_supported: {
    code: 'SIWC_ROUTE_NOT_SUPPORTED',
    advice: 'This endpoint or method is not supported for ChatGPT plan usage.',
  },
  subscription_sharing_invalid_user: {
    code: 'AUTH',
    advice: 'The ChatGPT subscriber context could not be validated.',
  },
  chatpass_v2_scope_not_authorized: {
    code: 'SIWC_SCOPE_NOT_AUTHORIZED',
    advice: 'The granted permissions do not authorize this operation.',
  },
  chatpass_v2_invalid_authorization_context: {
    code: 'SIWC_SCOPE_NOT_AUTHORIZED',
    advice: 'The granted permissions do not authorize this operation.',
  },
  subscription_sharing_user_unavailable: {
    code: 'SERVER',
    advice: 'ChatGPT account information is temporarily unavailable; retry later.',
  },
}

export interface ProviderErrorFacts {
  status?: number
  /** `error.code` from a structured body or `response.failed` event. */
  errorCode?: string
  /** `error.param`, when present. */
  param?: string
  /** `error.message` or admission `detail` — diagnostic text only. */
  detail?: string
  requestId?: string
  retryAfterMs?: number
}

function byStatus(status: number | undefined): Mapping {
  switch (true) {
    case status === 401:
      return { code: 'AUTH', advice: 'The access token or ChatGPT plan permission was not accepted.' }
    case status === 403:
      return { code: 'SIWC_FORBIDDEN', advice: 'A policy or permission check (for example serving region) blocked this request.' }
    case status === 404:
      return { code: 'SIWC_NOT_FOUND', advice: 'The requested model or route was not found for this account.' }
    case status === 429:
      return { code: 'RATE_LIMIT', advice: 'Too many requests; retry later.' }
    case status !== undefined && status >= 500:
      return { code: 'SERVER', advice: 'OpenAI returned a server error; retry later.' }
    default:
      return { code: 'SIWC_REQUEST_REJECTED', advice: 'The request was rejected.' }
  }
}

/** Build the terminal error for one failed Responses request or stream. */
export function providerError(f: ProviderErrorFacts): LlmError {
  const detail = f.detail ? redact(f.detail) : ''
  let mapping = (f.errorCode && STRUCTURED[f.errorCode]) || byStatus(f.status)
  if (isContextWindowExceededError(`${f.errorCode ?? ''} ${detail}`)) {
    mapping = { code: CONTEXT_WINDOW_EXCEEDED_CODE, advice: 'The conversation exceeds the model context window.' }
  }
  const facts = [
    f.errorCode && `code=${redact(f.errorCode)}`,
    f.param && `param=${redact(f.param)}`,
    f.status && `HTTP ${f.status}`,
    f.requestId && `request id ${redact(f.requestId)}`,
  ].filter(Boolean).join(', ')
  const message = `ChatGPT plan request failed${facts ? ` (${facts})` : ''}: ${mapping.advice}${detail ? ` Detail: ${detail}` : ''}`
  return new LlmError(message, mapping.code, {
    status: f.status,
    requestId: f.requestId ? (f.requestId as ProviderRequestId) : undefined,
    providerRetryAfterMs: f.retryAfterMs && f.retryAfterMs > 0 ? f.retryAfterMs : undefined,
  })
}

/**
 * OpenAI's request id for diagnostics. Observed on api.openai.com as
 * `x-oai-request-id`; the auth docs name `openai-request-id` / `x-request-id`.
 */
export function requestIdOf(headers: Headers): string | undefined {
  return headers.get('x-oai-request-id') ?? headers.get('openai-request-id') ?? headers.get('x-request-id') ?? undefined
}

/** Parse `retry-after` seconds or HTTP date into milliseconds. */
export function retryAfterMs(header: string | null): number | undefined {
  if (!header) return
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : undefined
  const at = Date.parse(header)
  return Number.isFinite(at) && at > Date.now() ? at - Date.now() : undefined
}
