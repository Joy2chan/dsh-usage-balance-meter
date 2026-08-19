/**
 * dsh-usage-meter — DeepSeek Harness usage & balance plugin.
 *
 * Registers two model-facing tools:
 *  - `deepseek_api_status`: connected DeepSeek account balance + current
 *    session token usage + optional cost estimate.
 *  - `api_overview`: all active LLM providers (`ctx.llm.listProviders()`) with
 *    per-provider call counts, token usage, optional cost, and balance status.
 *    The official DeepSeek balance adapter works out of the box; other
 *    providers can be wired through configurable HTTP balance adapters
 *    (`balanceProviders`).
 *
 * This is a host-only plugin: it needs `ctx.tools` and `ctx.llm`, and,
 * optionally, `ctx.credentials`.
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
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-commands'

export const name = 'usage-meter'
export const inject = ['tools', 'llm']

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_BALANCE_PATH = '/user/balance'
const OFFICIAL_PROVIDER = 'deepseek-official'

/**
 * One configurable HTTP balance adapter for a provider route. Lets non-official
 * providers (gateways, LiteLLM, …) expose a balance without writing adapter
 * code: point at any JSON endpoint, optionally extract a numeric/string value
 * with a dot path, and label the currency.
 */
export interface BalanceAdapterConfig {
  /** Provider route id this adapter applies to (`ctx.llm` provider id). */
  provider: string
  /** Optional endpoint base; falls back to the plugin `baseURL`. */
  baseURL?: string
  /** Path appended to the base URL, e.g. `/balance`. */
  path: string
  /** Optional extra HTTP headers (JSON object). Authorization is added unless `auth: "none"`. */
  headers?: Record<string, string>
  /** How to send the API key. Defaults to `bearer`. */
  auth?: 'bearer' | 'none'
  /** Optional dot-path into the JSON response (e.g. `data.balance`) to use as the value. */
  extract?: string
  /** Currency label for the extracted value. */
  currency?: string
}

export interface Config {
  /** Credential reference (environment-variable name) resolved per call; defaults to `DEEPSEEK_API_KEY`. */
  apiKeyEnv?: string
  /** API base URL; falls back to `$DEEPSEEK_BASE_URL`, then the public API. */
  baseURL?: string
  /** Path appended to `baseURL` for the official balance request; defaults to `/user/balance`. */
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
  /** Optional per-provider HTTP balance adapters for non-official providers. */
  balanceProviders?: BalanceAdapterConfig[]
}

const balanceAdapterSchema: z<BalanceAdapterConfig> = z.object({
  provider: z.string().required(),
  baseURL: z.string(),
  path: z.string().required(),
  headers: z.dict(z.string()),
  auth: z.union(['bearer', 'none']),
  extract: z.string(),
  currency: z.string(),
})

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
  balanceProviders: z.array(balanceAdapterSchema).default([]),
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
  readonly balanceAdapters: ReadonlyMap<string, BalanceAdapterConfig>
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
  const balanceAdapters = new Map<string, BalanceAdapterConfig>()
  for (const adapter of config.balanceProviders ?? []) {
    if (!adapter.path.startsWith('/')) {
      throw new TypeError(`dsh-usage-meter: balanceProvider "${adapter.provider}" path must start with "/"`)
    }
    balanceAdapters.set(adapter.provider, adapter)
  }
  return {
    apiKeyEnv,
    baseURL,
    balancePath,
    ...config.usagePath === undefined ? {} : { usagePath: config.usagePath },
    ...prices === undefined ? {} : { price: prices },
    currency: config.currency ?? 'USD',
    balanceAdapters,
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

/**
 * Perform one GET. Adds `Authorization: Bearer` unless `bearer` is false.
 * @returns parsed JSON body.
 */
async function getJson(
  endpoint: string,
  apiKey: string,
  signal: AbortSignal,
  headers: Record<string, string> = {},
  bearer = true,
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      ...(bearer ? { Authorization: `Bearer ${apiKey}` } : {}),
      Accept: 'application/json',
      ...headers,
    },
    signal,
  })
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`HTTP ${response.status} from ${endpoint}${body ? `: ${body}` : ''}`)
  }
  return response.json()
}

interface OfficialBalanceCurrencies {
  currency: string
  totalBalance: string
  grantedBalance: string
  toppedUpBalance: string
}

interface OfficialBalanceView {
  isAvailable: boolean
  currencies: OfficialBalanceCurrencies[]
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

async function fetchOfficialBalance(baseURL: string, balancePath: string, apiKey: string, signal: AbortSignal): Promise<OfficialBalanceView> {
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

/** Read a dot path (e.g. `data.balance`) from an arbitrary JSON value. */
function extractAtPath(value: unknown, path: string): unknown {
  let cursor = value
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

/** Balance detail attached to one provider in `api_overview`. */
interface ProviderBalanceInfo {
  adapter: 'official' | 'custom'
  status: 'ok'
  value?: number | string
  currency?: string
  currencies?: OfficialBalanceCurrencies[]
  raw?: JsonValue
}

async function fetchCustomBalance(
  baseURL: string,
  adapter: BalanceAdapterConfig,
  apiKey: string,
  signal: AbortSignal,
): Promise<ProviderBalanceInfo> {
  const endpoint = `${adapter.baseURL ?? baseURL}${adapter.path}`
  const raw = await getJson(endpoint, apiKey, signal, adapter.headers ?? {}, (adapter.auth ?? 'bearer') !== 'none')
  const extracted = adapter.extract === undefined ? undefined : extractAtPath(raw, adapter.extract)
  return {
    adapter: 'custom',
    status: 'ok',
    ...(typeof extracted === 'number' || typeof extracted === 'string' ? { value: extracted } : {}),
    ...(adapter.currency !== undefined ? { currency: adapter.currency } : {}),
    raw: raw as JsonValue,
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
  balance: ProviderBalanceInfo | null
  balanceReason: 'ok' | 'no-key' | 'error' | 'unsupported' | 'no-balance-adapter'
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
                  adapter: { type: 'string', required: true, enum: ['official', 'custom'] },
                  status: { type: 'string', required: true, enum: ['ok'] },
                  value: {
                    oneOf: [
                      { type: 'number' },
                      { type: 'string' },
                    ],
                  },
                  currency: { type: 'string' },
                  currencies: {
                    type: 'array',
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
                  raw: {
                    oneOf: [
                      { type: 'object', additionalProperties: true },
                      { type: 'array' },
                      { type: 'string' },
                      { type: 'number' },
                      { type: 'boolean' },
                      { type: 'null' },
                    ],
                  },
                },
              },
              { type: 'null' },
            ],
          },
          balanceReason: {
            type: 'string',
            enum: ['ok', 'no-key', 'error', 'unsupported', 'no-balance-adapter'],
          },
        },
      },
    },
  },
} as const

/**
 * Build per-provider overview rows used by both `api_overview` and the
 * `/cost` command. Resolves the key once, aggregates the current session's
 * usage per provider, and attaches the official or configured balance.
 */
async function buildProviderOverviews(
  ctx: Context,
  resolved: ResolvedConfig,
  signal: AbortSignal,
  events: readonly SessionEvent[],
): Promise<ProviderOverview[]> {
  const apiKey = await resolveApiKey(ctx, resolved.apiKeyEnv)
  const usageByProvider = collectProviderUsage(events)
  return Promise.all(ctx.llm.listProviders().map(async (info) => {
    const acc = usageByProvider.get(info.id)
    const usage = acc?.usage ?? zeroUsage()
    const cost = estimateCost(usage, resolved.price, resolved.currency)
    const adapter = resolved.balanceAdapters.get(info.id)
    let balance: ProviderBalanceInfo | null = null
    let balanceReason: ProviderOverview['balanceReason']

    if (apiKey === undefined) {
      balanceReason = info.id === OFFICIAL_PROVIDER ? 'no-key' : (adapter === undefined ? 'unsupported' : 'no-key')
    } else if (info.id === OFFICIAL_PROVIDER && adapter === undefined) {
      try {
        const view = await fetchOfficialBalance(resolved.baseURL, resolved.balancePath, apiKey, signal)
        balance = {
          adapter: 'official',
          status: 'ok',
          ...(view.currencies.length > 0 ? { currency: view.currencies[0]?.currency } : {}),
          currencies: view.currencies,
          raw: view as unknown as JsonValue,
        }
        balanceReason = 'ok'
      } catch {
        balance = null
        balanceReason = 'error'
      }
    } else if (adapter !== undefined) {
      try {
        balance = await fetchCustomBalance(resolved.baseURL, adapter, apiKey, signal)
        balanceReason = 'ok'
      } catch {
        balance = null
        balanceReason = 'error'
      }
    } else {
      balanceReason = 'unsupported'
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
}

/** Render one provider's balance line for the `/cost` command. */
function renderBalanceLine(provider: ProviderOverview): string {
  const b = provider.balance
  if (b === null) {
    switch (provider.balanceReason) {
      case 'no-key': return 'balance: no API key configured'
      case 'error': return 'balance: query failed'
      case 'no-balance-adapter': return 'balance: no adapter configured'
      default: return 'balance: not supported'
    }
  }
  if (b.adapter === 'official' && b.currencies !== undefined) {
    const detail = b.currencies
      .map(c => `${c.currency} ${c.totalBalance} (granted ${c.grantedBalance} / topped-up ${c.toppedUpBalance})`)
      .join(', ')
    return `balance: ${detail}`
  }
  const parts: string[] = []
  if (b.value !== undefined) parts.push(String(b.value))
  if (b.currency !== undefined) parts.push(b.currency)
  return parts.length > 0 ? `balance: ${parts.join(' ')}` : 'balance: ok'
}

/** Human-readable `/cost` output from the same projection `api_overview` uses. */
async function renderCostCommand(
  ctx: Context,
  resolved: ResolvedConfig,
  invocation: CommandInvocation,
  signal: AbortSignal,
): Promise<CommandResult> {
  const providers = await buildProviderOverviews(ctx, resolved, signal, invocation.agent.session.events)
  if (providers.length === 0) {
    return { kind: 'success', text: 'No active LLM providers found.' }
  }
  const lines: string[] = ['Usage & balance by provider:']
  for (const p of providers) {
    const u = p.usage
    lines.push(`• ${p.displayName} (${p.provider})`)
    lines.push(`  calls: ${p.calls} | input: ${u.inputTokens} | output: ${u.outputTokens} | cacheRead: ${u.cacheReadTokens} | cacheWrite: ${u.cacheWriteTokens}`)
    if (p.models.length > 0) lines.push(`  models: ${p.models.join(', ')}`)
    lines.push(`  cost: ${p.cost === null ? 'not configured' : `${p.cost.currency} ${p.cost.total.toFixed(6)}`}`)
    lines.push(`  ${renderBalanceLine(p)}`)
  }
  if (resolved.price === undefined) {
    lines.push('')
    lines.push('Tip: set inputPricePerMillion/outputPricePerMillion to enable cost estimates.')
  }
  return { kind: 'success', text: lines.join('\n') }
}

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
      const balance = await fetchOfficialBalance(resolved.baseURL, resolved.balancePath, apiKey, exec.signal)
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
      const providers = await buildProviderOverviews(ctx, resolved, exec.signal, exec.agent?.session.events ?? [])
      return { providers }
    },
    presentCall: () => ({ card: 'generic', title: 'List provider usage & balance', kind: 'read' }),
  }))

  ctx.inject(['commands'], (commandCtx) => {
    commandCtx.commands.register({
      name: 'cost',
      description: 'show current session usage, cost, and balance by provider',
      handler: invocation => renderCostCommand(ctx, resolved, invocation, invocation.signal),
    })
  })
}
