/**
 * Mount the real DSH services this plugin depends on — the LLM runtime, the
 * authorization seam, and the local credential store on a temp file — then the
 * plugin itself, pointed at a mock OpenAI.
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { AuthorizationService, type AuthorizationNotice } from '@deepseek-ai/dsh-authorization'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import { Config, applyWith } from '../../src/index.ts'
import type { SiwcAdapter } from '../../src/adapter.ts'
import type { SiwcSession } from '../../src/session.ts'
import type { MockOpenAI } from './mock-openai.ts'

export interface Harness {
  ctx: Context
  dir: string
  credentialsPath: string
  session: SiwcSession
  adapter: SiwcAdapter
  dispose(): Promise<void>
}

export async function mountHarness(mock: MockOpenAI, config: Partial<Config> = {}, credentialsPath?: string): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-siwc-'))
  const path = credentialsPath ?? join(dir, '.credentials.yaml')
  const ctx = new Context()
  await ctx.plugin(LocalCredentialProvider, { path })
  await ctx.plugin(LocalAttachmentStore, { dshHome: dir })
  await ctx.plugin(AuthorizationService)
  await ctx.plugin(LlmRuntime)
  let handles!: { session: SiwcSession; adapter: SiwcAdapter }
  await ctx.plugin({
    name: 'openai-siwc',
    inject: ['llm', 'credentials', 'authorization'],
    apply: (c: Context) => {
      handles = applyWith(c, Config(config as Config), mock.endpoints, 5_000)
    },
  })
  return {
    ctx,
    dir,
    credentialsPath: path,
    ...handles,
    async dispose() {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Run the registered sign-in flow, acting as the browser for the notice URL. */
export async function signIn(h: Harness, mock: MockOpenAI, answer: (message: string) => string = () => 'new') {
  const notices: AuthorizationNotice[] = []
  const pending: Promise<number>[] = []
  const outcome = await h.ctx.authorization.begin({
    key: (await import('../../src/store.ts')).SESSION_KEY,
    interaction: {
      notify(notice) {
        notices.push(notice)
        if (notice.url?.startsWith(mock.endpoints.authorize)) pending.push(mock.completeBrowserSignIn(notice.url))
      },
      async prompt(p) {
        return answer(p.message)
      },
    },
  })
  const callbackStatuses = await Promise.all(pending)
  return { outcome, notices, callbackStatuses }
}
