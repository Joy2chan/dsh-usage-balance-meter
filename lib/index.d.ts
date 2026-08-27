/**
 * dsh-usage-balance-meter — DeepSeek Harness usage & balance plugin.
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
 * @module dsh-usage-balance-meter
 */
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import { Ledger, type TotalsView } from './ledger.js';
export declare const name = "usage-meter";
export declare const inject: string[];
/**
 * One configurable HTTP balance adapter for a provider route. Lets non-official
 * providers (gateways, LiteLLM, …) expose a balance without writing adapter
 * code: point at any JSON endpoint, optionally extract a numeric/string value
 * with a dot path, and label the currency.
 */
export interface BalanceAdapterConfig {
    /** Provider route id this adapter applies to (`ctx.llm` provider id). */
    provider: string;
    /** Optional endpoint base; falls back to the plugin `baseURL`. */
    baseURL?: string;
    /** Path appended to the base URL, e.g. `/balance`. */
    path: string;
    /** Optional extra HTTP headers (JSON object). Authorization is added unless `auth: "none"`. */
    headers?: Record<string, string>;
    /** How to send the API key. Defaults to `bearer`. */
    auth?: 'bearer' | 'none';
    /** Optional dot-path into the JSON response (e.g. `data.balance`) to use as the value. */
    extract?: string;
    /** Currency label for the extracted value. */
    currency?: string;
}
/** A single pricing tier: USD per 1M tokens for each bucket. */
export interface PriceFields {
    /** Price per 1M input tokens. */
    inputPricePerMillion?: number;
    /** Price per 1M output tokens. */
    outputPricePerMillion?: number;
    /** Price per 1M cache-read tokens. */
    cacheReadPricePerMillion?: number;
    /** Price per 1M cache-write tokens. */
    cacheWritePricePerMillion?: number;
    /** Optional peak-tier prices (used when the call lands in a peak UTC window). */
    peak?: PriceFields;
    /** Optional off-peak-tier prices (used when the call lands outside a peak window). */
    offPeak?: PriceFields;
}
/** A provider's price table (default tier + exact model tiers). */
export interface ProviderPriceTable {
    /** Default tier for models without an exact entry under this provider. */
    default?: PriceFields;
    /** Exact per-model tiers. */
    models?: Record<string, PriceFields>;
    /** Currency this provider is billed in; overrides the global `currency`. */
    currency?: string;
}
/** Optional per-provider / per-model pricing overrides. */
export interface PriceTable {
    /** Global default tier; the top-level `*PricePerMillion` fields also act as a global default. */
    default?: PriceFields;
    /** Per-provider tables. */
    providers?: Record<string, ProviderPriceTable>;
}
/** Resolved (normalized) per-provider price table. */
export interface ResolvedProviderPriceTable {
    default?: ResolvedPriceConfig;
    models?: Record<string, ResolvedPriceConfig>;
    currency?: string;
}
/** Resolved price tier that may include flat fields plus peak/off-peak sub-tiers. */
export interface ResolvedPriceConfig {
    inputPricePerMillion?: number;
    outputPricePerMillion?: number;
    cacheReadPricePerMillion?: number;
    cacheWritePricePerMillion?: number;
    offPeak?: PriceConfig;
    peak?: PriceConfig;
}
/** Resolved (normalized) price table used at runtime. */
export interface ResolvedPriceTable {
    default?: ResolvedPriceConfig;
    providers?: Record<string, ResolvedProviderPriceTable>;
}
/** Budget configuration: a periodic cost limit with a warning band. */
export interface BudgetConfig {
    /** Whether the budget is enforced for display/command output. Defaults to false. */
    enabled?: boolean;
    /** Budget amount in the configured currency. */
    amount?: number;
    /** Budget period. Defaults to `month`. */
    period?: 'day' | 'month' | 'all' | 'custom';
    /** Inclusive start date for a `custom` period (`YYYY-MM-DD`). */
    customStart?: string;
    /** Inclusive end date for a `custom` period (`YYYY-MM-DD`). */
    customEnd?: string;
}
/** Warning/error thresholds expressed as percentages of the budget. */
export interface ThresholdsConfig {
    /** Percentage at which the budget is considered under warning. Defaults to 80. */
    warnPercent?: number;
    /** Percentage at which the budget is considered exceeded. Defaults to 100. */
    errorPercent?: number;
}
export interface Config {
    /** Credential reference (environment-variable name) resolved per call; defaults to `DEEPSEEK_API_KEY`. */
    apiKeyEnv?: string;
    /** API base URL; falls back to `$DEEPSEEK_BASE_URL`, then the public API. */
    baseURL?: string;
    /** Path appended to `baseURL` for the official balance request; defaults to `/user/balance`. */
    balancePath?: string;
    /**
     * Optional path appended to `baseURL` for an account-level usage request.
     * The official DeepSeek API does not currently document a public usage
     * endpoint, so this is only useful with gateways that provide one.
     */
    usagePath?: string;
    /** Optional price per million input tokens used to estimate session cost. */
    inputPricePerMillion?: number;
    /** Optional price per million output tokens used to estimate session cost. */
    outputPricePerMillion?: number;
    /** Optional price per million cache-read tokens used to estimate session cost. */
    cacheReadPricePerMillion?: number;
    /** Optional price per million cache-write tokens used to estimate session cost. */
    cacheWritePricePerMillion?: number;
    /** Currency label for the cost estimate. Defaults to `USD`. */
    currency?: string;
    /** Optional per-provider HTTP balance adapters for non-official providers. */
    balanceProviders?: BalanceAdapterConfig[];
    /** Optional periodic cost budget. */
    budget?: BudgetConfig;
    /** Optional budget warning/error thresholds (percentages). */
    thresholds?: ThresholdsConfig;
    /** Optional per-provider / per-model pricing overrides. */
    prices?: PriceTable;
    /** Optional UTC peak-hour windows used with `peak`/`offPeak` prices. Defaults to DeepSeek peak hours. */
    peakWindows?: Array<{
        start: number;
        end: number;
    }>;
    /** Optional explicit OpenCode Go API key; when omitted the key is auto-discovered from credentials/env/auth.json. */
    opencodeGoApiKey?: string;
}
export declare const Config: z<Config>;
interface PriceConfig {
    readonly inputPricePerMillion: number;
    readonly outputPricePerMillion: number;
    readonly cacheReadPricePerMillion: number;
    readonly cacheWritePricePerMillion: number;
}
interface ResolvedConfig {
    readonly apiKeyEnv: CredentialRef;
    readonly baseURL: string;
    readonly balancePath: string;
    readonly usagePath?: string;
    readonly price?: PriceConfig;
    readonly currency: string;
    readonly balanceAdapters: ReadonlyMap<string, BalanceAdapterConfig>;
    readonly budget: ResolvedBudget;
    readonly thresholds: ResolvedThresholds;
    readonly prices: ResolvedPriceTable;
    readonly peakWindows: ReadonlyArray<{
        readonly start: number;
        readonly end: number;
    }>;
    readonly opencodeGoApiKey?: string;
}
interface ResolvedBudget {
    readonly enabled: boolean;
    readonly amount: number;
    readonly period: BudgetConfig['period'];
    readonly customStart?: string;
    readonly customEnd?: string;
}
interface ResolvedThresholds {
    readonly warnPercent: number;
    readonly errorPercent: number;
}
/** Budget status view when a budget is enabled, otherwise null. */
interface BudgetStatusView {
    enabled: true;
    period: string;
    used: number;
    amount: number;
    percent: number;
    warnPercent: number;
    errorPercent: number;
}
/** Wire state the web client footer reads through `remote.usageMeter.getState()`. */
interface CostStateView {
    currency: string;
    today: TotalsView;
    month: TotalsView;
    all: TotalsView;
    budget: BudgetStatusView | null;
}
/** Register the plugin's two model-facing tools. */
/** Per-session cost/token projection surfaced to the web client footer. */
interface CostUsageProjection {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
    cost: number;
}
declare module '@deepseek-ai/dsh-session-projection/types' {
    interface SessionProjectionMap {
        costUsage: CostUsageProjection;
    }
}
/** Register the plugin's tools, persistent ledger, and slash command. */
/**
 * Build the host-side usageMeter Typert remote service. The returned object
 * carries a frozen typertRemote binding so the gateway can dispatch
 * usageMeter/getState to it. Kept as a small exported factory so apply()
 * and the regression tests share one construction path.
 */
export declare function bindUsageMeter(ctx: Context, ledger: Ledger, resolved: () => ResolvedConfig): {
    getState(): Promise<CostStateView>;
    typertRemote: unknown;
};
export declare function apply(ctx: Context, config: Config): void;
export {};
