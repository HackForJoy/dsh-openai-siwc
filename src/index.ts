/**
 * dsh-openai-siwc: a DeepSeek Harness LLM provider that uses OpenAI's
 * Sign in with ChatGPT "ChatGPT plan usage" flow for open-source clients.
 * Community plugin; not affiliated with or endorsed by OpenAI or DeepSeek.
 *
 * @module dsh-openai-siwc
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-authorization'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-llm'
import { PROVIDER, SiwcAdapter, type AdapterConfig } from './adapter.ts'
import { openSystemBrowser, type OpenBrowser } from './browser.ts'
import { createSiwcCommand } from './commands.ts'
import { createSignInFlow } from './flow.ts'
import { OFFICIAL_ENDPOINTS, type SiwcEndpoints } from './protocol.ts'
import { SiwcSession } from './session.ts'
import { PLUGIN_NAME, SESSION_KEY } from './store.ts'

export const name = PLUGIN_NAME
export const inject = ['llm', 'credentials', 'authorization']

export interface Config extends AdapterConfig {}

export const Config: z<Config> = z.object({
  defaultContextWindow: z.number().step(1).min(1).default(128_000)
    .description('Context window for a model whose catalog entry discloses none.'),
  models: z.dict(z.object({
    contextWindow: z.number().step(1).min(1),
  })).default({}).description('Per-model overrides keyed by model slug.'),
  streamIdleTimeoutMs: z.number().min(1).max(2_147_483_647).default(300_000)
    .description('Longest silence tolerated on an open response stream.'),
  maxRequestImageBytes: z.number().step(1).min(1).default(20 * 1024 * 1024)
    .description('Base64 image bytes one request may carry before older images are offloaded.'),
})

/**
 * Mount the plugin against a specific endpoint set. Production uses
 * {@link apply}; tests point this at a local mock server.
 */
export function applyWith(
  ctx: Context,
  config: Config,
  endpoints: SiwcEndpoints,
  callbackTimeoutMs?: number,
  openBrowser: OpenBrowser = openSystemBrowser,
) {
  const logger = ctx.logger(PLUGIN_NAME)
  const credentials = () => ctx.credentials
  const session = new SiwcSession(credentials, endpoints, logger)
  const adapter = new SiwcAdapter(session, endpoints, config, logger, () => ctx.get('attachments'))

  ctx.llm.registerAdapter([PROVIDER], adapter)
  ctx.authorization.registerFlow(createSignInFlow({ credentials, endpoints, logger, callbackTimeoutMs }))
  ctx.on('credentials/record-updated', (key) => {
    if (key === SESSION_KEY) adapter.invalidateCatalog()
  })
  ctx.inject(['commands'], (ctx) => {
    ctx.commands.register(createSiwcCommand(session, adapter, {
      authorization: () => ctx.authorization,
      openBrowser,
      authorizeUrl: endpoints.authorize,
    }))
  })
  return { session, adapter }
}

export function apply(ctx: Context, config: Config) {
  applyWith(ctx, config, OFFICIAL_ENDPOINTS)
}
