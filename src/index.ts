/**
 * dsh-usage-meter — DeepSeek Harness usage & balance plugin.
 *
 * Registers a model-facing `deepseek_api_status` tool that reads the connected
 * DeepSeek API account balance, the current session's provider-reported token
 * usage, and — when pricing is configured — an estimated session cost.
 *
 * This is a host-only plugin: it needs `ctx.tools` and, optionally,
 * `ctx.credentials`. It intentionally does not depend on the `llm-deepseek`
 * adapter being mounted.
 *
 * @module dsh-usage-meter
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { JsonValue, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'

export const name = 'usage-meter'
export const inject = ['tools']

const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEFAULT_BALANCE_PATH = '/user/balance'

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

/**
 * Sum provider-reported token usage from the durable session log. We use
 * `assistant/message` events because they are the final per-step usage anchor;
 * this avoids double counting `assistant/chunk` usage-only deltas.
 */
function collectSessionUsage(events: readonly SessionEvent[]): SessionUsage {
  const usage: SessionUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  }
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) continue
    const u = event.data.usage
    usage.inputTokens += u.inputTokens
    usage.outputTokens += u.outputTokens
    usage.cacheReadTokens += u.cacheReadTokens ?? 0
    usage.cacheWriteTokens += u.cacheWriteTokens ?? 0
    usage.reasoningTokens += u.reasoningTokens ?? 0
  }
  return usage
}

/** Estimated session cost from provider-reported usage, when pricing is configured. */
function estimateCost(usage: SessionUsage, price: PriceConfig | undefined, currency: string) {
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

/** Register the `deepseek_api_status` tool. */
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

      const balance = await getJson(`${resolved.baseURL}${resolved.balancePath}`, apiKey, exec.signal) as {
        is_available?: boolean
        balance_infos?: Array<{
          currency: string
          total_balance: string
          granted_balance: string
          topped_up_balance: string
        }>
      }
      let accountUsage: Record<string, JsonValue> | null = null
      if (resolved.usagePath !== undefined) {
        accountUsage = await getJson(`${resolved.baseURL}${resolved.usagePath}`, apiKey, exec.signal) as Record<string, JsonValue>
      }
      const usage = collectSessionUsage(exec.agent?.session.events ?? [])
      const cost = estimateCost(usage, resolved.price, resolved.currency)

      return {
        balance: {
          isAvailable: balance.is_available === true,
          currencies: (balance.balance_infos ?? []).map(entry => ({
            currency: entry.currency,
            totalBalance: entry.total_balance,
            grantedBalance: entry.granted_balance,
            toppedUpBalance: entry.topped_up_balance,
          })),
        },
        usage,
        accountUsage,
        cost,
        baseURL: resolved.baseURL,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Check DeepSeek API status', kind: 'read' }),
  }))
}
