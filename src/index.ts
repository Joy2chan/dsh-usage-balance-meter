/**
 * dsh-usage-meter — DeepSeek Harness usage & balance plugin.
 *
 * Registers two model-facing tools:
 *  - `deepseek_api_status`: connected DeepSeek account balance + current
 *    session token usage + optional cost estimate.
 *  - `api_overview`: all active LLM providers (`ctx.llm.listProviders()`) with
 *    per-provider call counts, token usage, optional cost, and balance status
 *    (DeepSeek official out of the box; other providers are marked
 *    "unsupported" until a balance adapter is configured).
 *
 * This is a host-only plugin: it needs `ctx.tools` and `ctx.llm`, and,
 * optionally, `ctx.credentials`. It intentionally does not depend on the
 * `llm-deepseek` adapter being mounted.
 *
 * @module dsh-usage-meter
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'

export const name = 'usage-meter'
export const inject = ['tools', 'llm']

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_BALANCE_PATH = '/user/balance'
const OFFICIAL_PROVIDER = 'deepseek-official'

/** Plugin configuration. */
export interface Config {
  /** Credential reference (environment-variable name) resolved per call; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** API base URL; falls back to `$DEEPSEEK_BASE_URL`, then the public API. */
  baseURL?: string
  /** Path appended to `baseURL` for the balance request; defaults to `/user/balance`. */
  balancePath?: string
  /**
   * Optional path appended to `baseURL` for an account-level usage request.
   * The official DeepSeek API does not currently document a public usage
   * endpoint, so this is only useful with gateways that provide one.
   */
  usagePath?: string
  /** Optional price per million input tokens used to estimate session cost. */
  inputPricePerMillion?: number
  /** Optional price per million output tokens used to estimate session cost. */
  outputPricePerMillion?: number
  /** Optional price per million cache-read tokens used to estimate session cost. */
  cacheReadPricePerMillion?: number
  /** Optional price per million cache-write tokens used to estimate session cost. */
  cacheWritePricePerMillion?: number
  /** Currency label for the cost estimate. Defaults to `USD`. */
  currency?: string
}

/** Schemastery config for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string(),
  balancePath: z.string().default(DEFAULT_BALANCE_PATH),
  usagePath: z.string(),
  inputPricePerMillion: z.number().min(0),
  outputPricePerMillion: z.number().min(0),
  cacheReadPricePerMillion: z.number().min(0),
  cacheWritePricePerMillion: z.number().min(0),
  currency: z.string().default('USD'),
})

interface PriceConfig {
  readonly inputPricePerMillion: number
  readonly outputPricePerMillion: number
  readonly cacheReadPricePerMillion: number
  readonly cacheWritePricePerMillion: number
}

interface ResolvedConfig {
  readonly apiKeyEnv: CredentialRef
  readonly baseURL: string
  readonly balancePath: string
  readonly usagePath?: string
  readonly price?: PriceConfig
  readonly currency: string
}

function resolveConfig(config: Config): ResolvedConfig {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const baseURL = (config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
  const balancePath = config.balancePath ?? DEFAULT_BALANCE_PATH
  if (!balancePath.startsWith('/')) {
    throw new TypeError('dsh-usage-meter: balancePath must start with "/"')
  }
  if (config.usagePath !== undefined && !config.usagePath.startsWith('/')) {
    throw new TypeError('dsh-usage-meter: usagePath must start with "/"')
  }
  const prices: PriceConfig | undefined = config.inputPricePerMillion === undefined
    && config.outputPricePerMillion === undefined
    && config.cacheReadPricePerMillion === undefined
    && config.cacheWritePricePerMillion === undefined
    ? undefined
    : {
      inputPricePerMillion: config.inputPricePerMillion ?? 0,
      outputPricePerMillion: config.outputPricePerMillion ?? 0,
      cacheReadPricePerMillion: config.cacheReadPricePerMillion ?? 0,
      cacheWritePricePerMillion: config.cacheWritePricePerMillion ?? 0,
    }
  return {
    apiKeyEnv,
    baseURL,
    balancePath,
    ...config.usagePath === undefined ? {} : { usagePath: config.usagePath },
    ...prices === undefined ? {} : { price: prices },
    currency: config.currency ?? 'USD',
  }
}

/**
 * Resolve the API key for one call. The credential seam is preferred; without
 * it the trusted launch environment is the whole credential plane.
 */
async function resolveApiKey(ctx: Context, ref: CredentialRef): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) {
    const hit = await credentials.resolve(ref)
    if (hit !== undefined) return hit.value
  }
  const ambient = launchEnvironmentOf(ctx).get(ref)
  if (ambient !== undefined && ambient.value.length > 0) return ambient.value
  return undefined
}

/** Disjoint provider-reported usage buckets for one compiled session. */
interface SessionUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
}

function zeroUsage(): SessionUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
}

function addUsage(target: SessionUsage, u: TokenUsage): void {
  target.inputTokens += u.inputTokens
  target.outputTokens += u.outputTokens
  target.cacheReadTokens += u.cacheReadTokens ?? 0
  target.cacheWriteTokens += u.cacheWriteTokens ?? 0
  target.reasoningTokens += u.reasoningTokens ?? 0
}

/**
 * Sum provider-reported token usage from the durable session log. We use
 * `assistant/message` events because they are the final per-step usage anchor;
 * this avoids double counting `assistant/chunk` usage-only deltas.
 */
function collectSessionUsage(events: readonly SessionEvent[]): SessionUsage {
  const usage = zeroUsage()
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    addUsage(usage, event.data.usage)
  }
  return usage
}

interface ProviderAccumulator {
  calls: number
  models: Set<string>
  usage: SessionUsage
}

function zeroAccumulator(): ProviderAccumulator {
  return { calls: 0, models: new Set(), usage: zeroUsage() }
}

function addStep(acc: ProviderAccumulator, model: string, u: TokenUsage): ProviderAccumulator {
  acc.models.add(model)
  acc.calls += 1
  addUsage(acc.usage, u)
  return acc
}

/**
 * Aggregate per-provider usage from the current session log. Providers with no
 * recorded calls simply do not appear here; the envelope merges them with the
 * live `ctx.llm.listProviders()` set so the model sees the whole topology.
 */
function collectProviderUsage(events: readonly SessionEvent[]): Map<string, ProviderAccumulator> {
  const byProvider = new Map<string, ProviderAccumulator>()
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    const provider = event.data.message.source.provider
    const model = event.data.message.source.model
    const acc = byProvider.get(provider) ?? zeroAccumulator()
    byProvider.set(provider, addStep(acc, model, event.data.usage))
  }
  return byProvider
}

interface CostEstimate {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  total: number
  currency: string
}

/** Estimated session cost from provider-reported usage, when pricing is configured. */
function estimateCost(usage: SessionUsage, price: PriceConfig | undefined, currency: string): CostEstimate | null {
  if (price === undefined) return null
  const input = (usage.inputTokens / 1_000_000) * price.inputPricePerMillion
  const output = (usage.outputTokens / 1_000_000) * price.outputPricePerMillion
  const cacheRead = (usage.cacheReadTokens / 1_000_000) * price.cacheReadPricePerMillion
  const cacheWrite = (usage.cacheWriteTokens / 1_000_000) * price.cacheWritePricePerMillion
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: input + output + cacheRead + cacheWrite,
    currency,
  }
}

/** Perform one authenticated GET and parse the JSON body. */
async function getJson(endpoint: string, apiKey: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`DeepSeek API request to ${endpoint} failed (HTTP ${response.status})${body ? `: ${body}` : ''}`)
  }
  return response.json()
}

interface BalanceView {
  isAvailable: boolean
  currencies: Array<{
    currency: string
    totalBalance: string
    grantedBalance: string
    toppedUpBalance: string
  }>
}

interface BalanceResponse {
  is_available?: boolean
  balance_infos?: Array<{
    currency: string
    total_balance: string
    granted_balance: string
    topped_up_balance: string
  }>
}

async function fetchBalanceView(baseURL: string, balancePath: string, apiKey: string, signal: AbortSignal): Promise<BalanceView> {
  const data = await getJson(`${baseURL}${balancePath}`, apiKey, signal) as BalanceResponse
  return {
    isAvailable: data.is_available === true,
    currencies: (data.balance_infos ?? []).map((entry) => ({
      currency: entry.currency,
      totalBalance: entry.total_balance,
      grantedBalance: entry.granted_balance,
      toppedUpBalance: entry.topped_up_balance,
    })),
  }
}

/** Provider row returned by `api_overview`. */
interface ProviderOverview {
  provider: string
  displayName: string
  calls: number
  models: string[]
  usage: SessionUsage
  cost: CostEstimate | null
  balance: BalanceView | null
  balanceReason: 'unsupported' | 'no-key' | 'error' | 'ok'
}

const PROVIDER_OVERVIEW_VALUE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    providers: {
      type: 'array' as const,
      required: true,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          displayName: { type: 'string', required: true },
          calls: { type: 'integer', required: true },
          models: { type: 'array', required: true, items: { type: 'string' } },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              inputTokens: { type: 'integer', required: true },
              outputTokens: { type: 'integer', required: true },
              cacheReadTokens: { type: 'integer', required: true },
              cacheWriteTokens: { type: 'integer', required: true },
              reasoningTokens: { type: 'integer', required: true },
            },
          },
          cost: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  input: { type: 'number', required: true },
                  output: { type: 'number', required: true },
                  cacheRead: { type: 'number', required: true },
                  cacheWrite: { type: 'number', required: true },
                  total: { type: 'number', required: true },
                  currency: { type: 'string', required: true },
                },
              },
              { type: 'null' },
            ],
          },
          balance: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  isAvailable: { type: 'boolean', required: true },
                  currencies: {
                    type: 'array',
                    required: true,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        currency: { type: 'string', required: true },
                        totalBalance: { type: 'string', required: true },
                        grantedBalance: { type: 'string', required: true },
                        toppedUpBalance: { type: 'string', required: true },
                      },
                    },
                  },
                },
              },
              { type: 'null' },
            ],
          },
          balanceReason: {
            type: 'string',
            enum: ['unsupported', 'no-key', 'error', 'ok'],
          },
        },
      },
    },
  },
} as const

/** Register the plugin's two model-facing tools. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)

  ctx.tools.register(defineTool({
    name: 'deepseek_api_status',
    description:
      'Read the currently connected DeepSeek API account balance and the current session token usage. '
      + 'Use this when the user asks about API quota, balance, credits, usage, or cost.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          balance: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  isAvailable: { type: 'boolean', required: true },
                  currencies: {
                    type: 'array',
                    required: true,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        currency: { type: 'string', required: true },
                        totalBalance: { type: 'string', required: true },
                        grantedBalance: { type: 'string', required: true },
                        toppedUpBalance: { type: 'string', required: true },
                      },
                    },
                  },
                },
              },
              { type: 'null' },
            ],
          },
          usage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              inputTokens: { type: 'integer', required: true },
              outputTokens: { type: 'integer', required: true },
              cacheReadTokens: { type: 'integer', required: true },
              cacheWriteTokens: { type: 'integer', required: true },
              reasoningTokens: { type: 'integer', required: true },
            },
          },
          accountUsage: {
            oneOf: [
              { type: 'object', additionalProperties: true },
              { type: 'null' },
            ],
          },
          cost: {
            oneOf: [
              {
                type: 'object',
                additionalProperties: false,
                properties: {
                  input: { type: 'number', required: true },
                  output: { type: 'number', required: true },
                  cacheRead: { type: 'number', required: true },
                  cacheWrite: { type: 'number', required: true },
                  total: { type: 'number', required: true },
                  currency: { type: 'string', required: true },
                },
              },
              { type: 'null' },
            ],
          },
          baseURL: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    async execute(_args, exec) {
      const apiKey = await resolveApiKey(ctx, resolved.apiKeyEnv)
      if (apiKey === undefined) {
        throw new Error(
          `No DeepSeek API key found for "${resolved.apiKeyEnv}". Store it through the credentials service or export it in the environment.`,
        )
      }
      const usage = collectSessionUsage(exec.agent?.session.events ?? [])
      const cost = estimateCost(usage, resolved.price, resolved.currency)
      let accountUsage: Record<string, JsonValue> | null = null
      if (resolved.usagePath !== undefined) {
        accountUsage = await getJson(`${resolved.baseURL}${resolved.usagePath}`, apiKey, exec.signal) as Record<string, JsonValue>
      }
      const balance = await fetchBalanceView(resolved.baseURL, resolved.balancePath, apiKey, exec.signal)
      return {
        balance,
        usage,
        accountUsage,
        cost,
        baseURL: resolved.baseURL,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check DeepSeek API status', kind: 'read' }),
  }))

  ctx.tools.register(defineTool({
    name: 'api_overview',
    description:
      'List every active LLM provider with its current session call count, token usage, '
      + 'models used, cost estimate, and balance status. Use this when the user asks about '
      + 'multiple providers, per-provider usage, or the balance of every connected API.',
    parameters: {},
    output: {
      schema: PROVIDER_OVERVIEW_VALUE_SCHEMA,
      render: (_args, value) => [{
        type: 'text',
        text: JSON.stringify(value),
      }],
    },
    async execute(_args, exec) {
      const apiKey = await resolveApiKey(ctx, resolved.apiKeyEnv)
      const usageByProvider = collectProviderUsage(exec.agent?.session.events ?? [])
      const providers: ProviderOverview[] = await Promise.all(ctx.llm.listProviders().map(async (info) => {
        const acc = usageByProvider.get(info.id)
        const usage = acc?.usage ?? zeroUsage()
        const cost = estimateCost(usage, resolved.price, resolved.currency)
        let balance: BalanceView | null = null
        let balanceReason: ProviderOverview['balanceReason'] = 'unsupported'
        if (info.id === OFFICIAL_PROVIDER) {
          if (apiKey === undefined) {
            balanceReason = 'no-key'
          } else {
            try {
              balance = await fetchBalanceView(resolved.baseURL, resolved.balancePath, apiKey, exec.signal)
              balanceReason = 'ok'
            } catch {
              balance = null
              balanceReason = 'error'
            }
          }
        }
        return {
          provider: info.id,
          displayName: info.name,
          calls: acc?.calls ?? 0,
          models: acc === undefined ? [] : [...acc.models].sort(),
          usage,
          cost,
          balance,
          balanceReason,
        }
      }))
      return { providers }
    },
    presentCall: () => ({ card: 'generic', title: 'List provider usage & balance', kind: 'read' }),
  }))
}
