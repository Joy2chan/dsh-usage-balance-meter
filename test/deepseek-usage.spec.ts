import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'

function fakeContext() {
  const tools: Array<{ name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }> = []
  const ctx = {
    get: () => undefined,
    tools: {
      register: (definition: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> }) => {
        tools.push(definition)
        return () => {}
      },
    },
  }
  return { ctx, tool: () => tools[0] }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('dsh-usage-meter', () => {
  it('registers the deepseek_api_status tool', () => {
    const { ctx, tool } = fakeContext()
    apply(ctx, { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' })
    expect(tool()?.name).toBe('deepseek_api_status')
  })

  it('fetches balance, collects session usage, and returns the normalized result', async () => {
    const { ctx, tool } = fakeContext()
    apply(ctx, {
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      baseURL: 'https://api.deepseek.com',
      usagePath: '/usage',
      inputPricePerMillion: 1,
      outputPricePerMillion: 2,
      cacheReadPricePerMillion: 0.5,
      cacheWritePricePerMillion: 0.25,
      currency: 'USD',
    })

    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/usage')) {
        return { ok: true, status: 200, json: async () => ({ total_tokens: 123 }), text: async () => '' }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: '12.34', granted_balance: '1.00', topped_up_balance: '11.34' },
          ],
        }),
        text: async () => '',
      }
    })

    process.env.DEEPSEEK_API_KEY = 'sk-test'
    const agent = {
      session: {
        events: [
          { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 0, reasoningTokens: 2 } } },
          { type: 'assistant/message', data: { usage: { inputTokens: 7, outputTokens: 4 } } },
        ],
      },
    }
    const result = await tool()!.execute({}, { agent, signal: new AbortController().signal })
    expect(result).toEqual({
      balance: {
        isAvailable: true,
        currencies: [
          { currency: 'CNY', totalBalance: '12.34', grantedBalance: '1.00', toppedUpBalance: '11.34' },
        ],
      },
      usage: {
        inputTokens: 17,
        outputTokens: 9,
        cacheReadTokens: 3,
        cacheWriteTokens: 0,
        reasoningTokens: 2,
      },
      accountUsage: { total_tokens: 123 },
      cost: {
        input: (17 / 1_000_000) * 1,
        output: (9 / 1_000_000) * 2,
        cacheRead: (3 / 1_000_000) * 0.5,
        cacheWrite: (0 / 1_000_000) * 0.25,
        total: (17 / 1_000_000) * 1 + (9 / 1_000_000) * 2 + (3 / 1_000_000) * 0.5 + (0 / 1_000_000) * 0.25,
        currency: 'USD',
      },
      baseURL: 'https://api.deepseek.com',
    })
    delete process.env.DEEPSEEK_API_KEY
  })

  it('throws a clear error when no API key is available', async () => {
    const { ctx, tool } = fakeContext()
    apply(ctx, { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com' })
    delete process.env.DEEPSEEK_API_KEY
    await expect(tool()!.execute({}, { agent: { session: { events: [] } }, signal: new AbortController().signal }))
      .rejects.toThrow(/No DeepSeek API key found/)
  })
})
