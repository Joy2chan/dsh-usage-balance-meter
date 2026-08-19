import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'

interface ToolLike {
  name: string
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

function fakeContext(providers: Array<{ id: string; name: string }>) {
  const tools: ToolLike[] = []
  const ctx = {
    get: () => undefined,
    tools: {
      register: (definition: ToolLike) => {
        tools.push(definition)
        return () => {}
      },
    },
    llm: {
      listProviders: () => providers,
    },
  }
  return { ctx, tool: (name: string) => tools.find(t => t.name === name) }
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.DEEPSEEK_API_KEY
})

describe('api_overview', () => {
  it('registers both tools', () => {
    const { ctx, tool } = fakeContext([{ id: 'deepseek-official', name: 'DeepSeek' }])
    apply(ctx, { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' })
    expect(tool('deepseek_api_status')?.name).toBe('deepseek_api_status')
    expect(tool('api_overview')?.name).toBe('api_overview')
  })

  it('aggregates per-provider usage and attaches official balance', async () => {
    const { ctx, tool } = fakeContext([
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'deepseek', name: 'DeepSeek (pi-ai)' },
    ])
    apply(ctx, {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: 'https://api.deepseek.com',
      inputPricePerMillion: 1,
      outputPricePerMillion: 2,
      currency: 'USD',
    })

    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        is_available: true,
        balance_infos: [
          { currency: 'CNY', total_balance: '12.34', granted_balance: '1.00', topped_up_balance: '11.34' },
        ],
      }),
      text: async () => '',
    }))

    process.env.DEEPSEEK_API_KEY = 'sk-test'
    const agent = {
      session: {
        events: [
          { type: 'assistant/message', data: { message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 2 } } },
          { type: 'assistant/message', data: { message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } }, usage: { inputTokens: 7, outputTokens: 4 } } },
          { type: 'assistant/message', data: { message: { source: { provider: 'deepseek', model: 'deepseek-chat' } }, usage: { inputTokens: 2, outputTokens: 1 } } },
        ],
      },
    }

    const result = await tool('api_overview')!.execute({}, { agent, signal: new AbortController().signal }) as {
      providers: Array<{
        provider: string
        calls: number
        models: string[]
        usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number }
        cost: { total: number } | null
        balance: {
          adapter: string
          status: string
          currency?: string
          currencies?: Array<{ currency: string; totalBalance: string; grantedBalance: string; toppedUpBalance: string }>
        } | null
        balanceReason: string
      }>
    }

    const byId = new Map(result.providers.map(p => [p.provider, p]))
    const official = byId.get('deepseek-official')!
    const piAi = byId.get('deepseek')!

    expect(official.calls).toBe(2)
    expect(official.models).toEqual(['deepseek-v4-flash'])
    expect(official.usage).toEqual({ inputTokens: 17, outputTokens: 9, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 2 })
    expect(official.balance).toMatchObject({
      adapter: 'official',
      status: 'ok',
      currency: 'CNY',
      currencies: [{ currency: 'CNY', totalBalance: '12.34', grantedBalance: '1.00', toppedUpBalance: '11.34' }],
    })
    expect(official.balanceReason).toBe('ok')

    expect(piAi.calls).toBe(1)
    expect(piAi.models).toEqual(['deepseek-chat'])
    expect(piAi.usage).toEqual({ inputTokens: 2, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
    expect(piAi.balance).toBeNull()
    expect(piAi.balanceReason).toBe('unsupported')
  })

  it('uses a configured custom balance adapter for a non-official provider', async () => {
    const { ctx, tool } = fakeContext([
      { id: 'deepseek-official', name: 'DeepSeek' },
      { id: 'openai', name: 'OpenAI' },
    ])
    apply(ctx, {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: 'https://api.deepseek.com',
      balanceProviders: [
        {
          provider: 'openai',
          path: '/v1/dashboard/billing/credit_grants',
          extract: 'grants.0.error', // will be undefined -> no value, raw preserved
          currency: 'USD',
        },
      ],
    })

    vi.stubGlobal('fetch', async (url: string) => {
      if (String(url).includes('/v1/dashboard/billing/credit_grants')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ grants: [{ id: 'g1', amount: 25 }] }),
          text: async () => '',
        }
      }
      if (String(url).includes('deepseek.com')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ is_available: true, balance_infos: [] }),
          text: async () => '',
        }
      }
      throw new Error(`unexpected url ${url}`)
    })

    process.env.DEEPSEEK_API_KEY = 'sk-test'
    const agent = { session: { events: [] } }
    const result = await tool('api_overview')!.execute({}, { agent, signal: new AbortController().signal }) as {
      providers: Array<{ provider: string; balance: { adapter: string; status: string; currency?: string; raw?: unknown } | null; balanceReason: string }>
    }
    const openai = result.providers.find(p => p.provider === 'openai')!
    expect(openai.balance).toMatchObject({
      adapter: 'custom',
      status: 'ok',
      currency: 'USD',
      raw: { grants: [{ id: 'g1', amount: 25 }] },
    })
    expect(openai.balanceReason).toBe('ok')
  })
})
