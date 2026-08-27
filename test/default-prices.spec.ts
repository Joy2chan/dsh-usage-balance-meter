import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, Config } from '../src/index.js'

function fakeContext() {
  const tools: Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }> = []
  const ctx: Record<string, unknown> = {
    get: () => undefined,
    on: () => {},
    effect: () => {},
    inject: () => {},
    tools: { register: (d: never) => { tools.push(d as never); return () => {} } },
    llm: { listProviders: () => [{ id: 'opencode-go', name: 'OpenCode Go' }] },
  }
  return { ctx, tool: (n: string) => tools.find(t => t.name === n) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.DEEPSEEK_API_KEY
})

describe('baked default prices', () => {
  it('shows a nonzero provider cost without any user pricing config', async () => {
    const { ctx, tool } = fakeContext()
    apply(ctx, { apiKeyEnv: 'DEEPSEEK_API_KEY' })
    process.env.DEEPSEEK_API_KEY = 'x'
    const agent = { session: { events: [
      { type: 'assistant/message', data: { message: { source: { provider: 'opencode-go', model: 'deepseek-v4-flash' } }, usage: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 } } },
    ] } }
    const res = await tool('api_overview')!.execute({}, { agent, signal: new AbortController().signal }) as {
      providers: Array<{ provider: string; cost: { total: number } | null }>
    }
    const row = res.providers.find(p => p.provider === 'opencode-go')!
    expect(row.cost).not.toBeNull()
    expect(row.cost!.total).toBeGreaterThan(0)
  })

  it('survives schemastery normalization (empty injected default tiers ignored)', async () => {
    const raw = {
      currency: 'USD',
      prices: {
        default: { offPeak: { inputPricePerMillion: 0.22, outputPricePerMillion: 0.66, cacheReadPricePerMillion: 0.007 }, peak: { inputPricePerMillion: 0.44, outputPricePerMillion: 1.32, cacheReadPricePerMillion: 0.014 } },
        providers: {
          'opencode-go': {
            currency: 'USD',
            models: {
              'deepseek-v4-flash': { offPeak: { inputPricePerMillion: 0.22, outputPricePerMillion: 0.66, cacheReadPricePerMillion: 0.007 }, peak: { inputPricePerMillion: 0.44, outputPricePerMillion: 1.32, cacheReadPricePerMillion: 0.014 } },
            },
          },
        },
      },
    }
    const validated = Config(raw) as unknown as Parameters<typeof apply>[1]
    const { ctx, tool } = fakeContext()
    apply(ctx, validated)
    process.env.DEEPSEEK_API_KEY = 'x'
    const agent = { session: { events: [
      { type: 'assistant/message', data: { message: { source: { provider: 'opencode-go', model: 'deepseek-v4-flash' } }, usage: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 } } },
    ] } }
    const res = await tool('api_overview')!.execute({}, { agent, signal: new AbortController().signal }) as { providers: Array<{ cost: { total: number } | null }> }
    const row = res.providers.find(p => p.provider === 'opencode-go')!
    expect(row.cost?.total ?? 0).toBeGreaterThan(0)
  })

  it('prices through Config() normalization with no user prices (regression: schemastery injects an empty prices object)', async () => {
    const validated = Config(undefined) as unknown as Parameters<typeof apply>[1]
    const { ctx, tool } = fakeContext()
    apply(ctx, validated)
    process.env.DEEPSEEK_API_KEY = 'x'
    const agent = { session: { events: [
      { type: 'assistant/message', data: { message: { source: { provider: 'opencode-go', model: 'deepseek-v4-flash' } }, usage: { inputTokens: 1000000, outputTokens: 1000000, cacheReadTokens: 1000000 } } },
    ] } }
    const res = await tool('api_overview')!.execute({}, { agent, signal: new AbortController().signal }) as { providers: Array<{ provider: string; cost: { total: number } | null }> }
    const row = res.providers.find(p => p.provider === 'opencode-go')!
    expect(row.cost).not.toBeNull()
    expect(row.cost!.total).toBeGreaterThan(0)
  })
})
