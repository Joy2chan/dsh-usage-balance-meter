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
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { z as zod } from 'zod';
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings';
import { Ledger, localDayKey } from './ledger.js';
export const name = 'usage-meter';
export const inject = ['tools', 'llm'];
/** Diagnostic marker so installed builds can be distinguished at runtime. */
const BUILD_VERSION = 'dsh-usage-balance-meter@0.1.0 (empty-tier-fix)';
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY';
const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_BALANCE_PATH = '/user/balance';
const OFFICIAL_PROVIDER = 'deepseek-official';
const SETTINGS_NS = settingsNamespace('usage-meter');
const priceFieldsInnerSchema = z.object({
    inputPricePerMillion: z.number().min(0),
    outputPricePerMillion: z.number().min(0),
    cacheReadPricePerMillion: z.number().min(0),
    cacheWritePricePerMillion: z.number().min(0),
});
const priceFieldsSchema = z.object({
    inputPricePerMillion: z.number().min(0),
    outputPricePerMillion: z.number().min(0),
    cacheReadPricePerMillion: z.number().min(0),
    cacheWritePricePerMillion: z.number().min(0),
    peak: priceFieldsInnerSchema,
    offPeak: priceFieldsInnerSchema,
});
const providerPriceTableSchema = z.object({
    default: priceFieldsSchema,
    models: z.dict(priceFieldsSchema),
    currency: z.string(),
});
const priceTableSchema = z.object({
    default: priceFieldsSchema,
    providers: z.dict(providerPriceTableSchema),
});
const balanceAdapterSchema = z.object({
    provider: z.string().required(),
    baseURL: z.string(),
    path: z.string().required(),
    headers: z.dict(z.string()),
    auth: z.union(['bearer', 'none']),
    extract: z.string(),
    currency: z.string(),
});
export const Config = z.object({
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
    budget: z.object({
        enabled: z.boolean().default(false),
        amount: z.number().min(0).default(0),
        period: z.union(['day', 'month', 'all', 'custom']).default('month'),
        customStart: z.string(),
        customEnd: z.string(),
    }),
    thresholds: z.object({
        warnPercent: z.number().min(0).max(100).default(80),
        errorPercent: z.number().min(0).max(100).default(100),
    }),
    prices: priceTableSchema,
    peakWindows: z.array(z.object({
        start: z.number().min(0).max(23),
        end: z.number().min(0).max(24),
    })).default([{ start: 1, end: 4 }, { start: 6, end: 10 }]),
});
/** Convert optional price fields into a resolved price config. */
function hasAnyPrice(fields) {
    return fields !== undefined && (fields.inputPricePerMillion !== undefined
        || fields.outputPricePerMillion !== undefined
        || fields.cacheReadPricePerMillion !== undefined
        || fields.cacheWritePricePerMillion !== undefined);
}
function subPrice(fields) {
    return hasAnyPrice(fields) ? normalizeFlat(fields) : undefined;
}
function normalizePriceFields(fields) {
    if (!hasAnyPrice(fields) && !hasAnyPrice(fields?.peak) && !hasAnyPrice(fields?.offPeak)) {
        return undefined;
    }
    const peak = subPrice(fields?.peak);
    const offPeak = subPrice(fields?.offPeak);
    return {
        ...(hasAnyPrice(fields) ? normalizeFlat(fields) : {}),
        ...(peak !== undefined ? { peak } : {}),
        ...(offPeak !== undefined ? { offPeak } : {}),
    };
}
function normalizeFlat(fields) {
    return {
        inputPricePerMillion: fields.inputPricePerMillion ?? 0,
        outputPricePerMillion: fields.outputPricePerMillion ?? 0,
        cacheReadPricePerMillion: fields.cacheReadPricePerMillion ?? 0,
        cacheWritePricePerMillion: fields.cacheWritePricePerMillion ?? 0,
    };
}
/** Build a resolved price table from config, merging the baked defaults. */
function buildResolvedPriceTable(config) {
    const userSetTopGlobal = config.inputPricePerMillion !== undefined
        || config.outputPricePerMillion !== undefined
        || config.cacheReadPricePerMillion !== undefined
        || config.cacheWritePricePerMillion !== undefined;
    const userTopGlobal = userSetTopGlobal
        ? {
            ...config.inputPricePerMillion !== undefined ? { inputPricePerMillion: config.inputPricePerMillion } : {},
            ...config.outputPricePerMillion !== undefined ? { outputPricePerMillion: config.outputPricePerMillion } : {},
            ...config.cacheReadPricePerMillion !== undefined ? { cacheReadPricePerMillion: config.cacheReadPricePerMillion } : {},
            ...config.cacheWritePricePerMillion !== undefined ? { cacheWritePricePerMillion: config.cacheWritePricePerMillion } : {},
        }
        : undefined;
    const rawDefault = config.prices?.default ?? userTopGlobal;
    // If the user set their own top-level global price, do not auto-apply the
    // baked provider prices (they are a fallback, not an override).
    const rawProviders = config.prices?.providers
        ?? (userSetTopGlobal ? undefined : DEFAULT_PRICE_TABLE.providers);
    const providers = rawProviders === undefined
        ? undefined
        : Object.fromEntries(Object.entries(rawProviders).map(([provider, table]) => [
            provider,
            {
                ...table.currency !== undefined ? { currency: table.currency } : {},
                ...table.default !== undefined ? { default: normalizePriceFields(table.default) } : {},
                ...table.models !== undefined
                    ? {
                        models: Object.fromEntries(Object.entries(table.models)
                            .map(([model, fields]) => [model, normalizePriceFields(fields)])
                            .filter((entry) => entry[1] !== undefined)),
                    }
                    : {},
            },
        ]));
    return {
        ...rawDefault !== undefined ? { default: normalizePriceFields(rawDefault) } : {},
        ...providers !== undefined ? { providers } : {},
    };
}
/** Resolve the price to bill for one provider/model call. */
function priceFor(provider, model, resolved) {
    const providerTable = resolved.prices.providers?.[provider];
    if (providerTable !== undefined) {
        if (model !== undefined && providerTable.models?.[model] !== undefined) {
            return providerTable.models?.[model];
        }
        if (providerTable.default !== undefined)
            return providerTable.default;
        // Provider summary rows have no single model: fall back to the first
        // configured model's tier so the row still shows a real cost.
        const firstModel = Object.values(providerTable.models ?? {})[0];
        if (firstModel !== undefined)
            return firstModel;
    }
    return resolved.prices.default ?? resolved.price;
}
/** Resolve the currency a provider is billed in. */
function currencyFor(provider, resolved) {
    return resolved.prices.providers?.[provider]?.currency ?? resolved.currency;
}
/** Default UTC peak windows (hours): DeepSeek peak 01:00-04:00, 06:00-10:00. */
const DEFAULT_PEAK_WINDOWS = [
    { start: 1, end: 4 },
    { start: 6, end: 10 },
];
/** Default price table (off-peak / peak) baked into the plugin. */
const DEFAULT_PRICE_TABLE = {
    default: {
        offPeak: { inputPricePerMillion: 0.22, outputPricePerMillion: 0.66, cacheReadPricePerMillion: 0.007 },
        peak: { inputPricePerMillion: 0.44, outputPricePerMillion: 1.32, cacheReadPricePerMillion: 0.014 },
    },
    providers: {
        'opencode-go': {
            currency: 'USD',
            models: {
                'deepseek-v4-flash': {
                    offPeak: { inputPricePerMillion: 0.22, outputPricePerMillion: 0.66, cacheReadPricePerMillion: 0.007 },
                    peak: { inputPricePerMillion: 0.44, outputPricePerMillion: 1.32, cacheReadPricePerMillion: 0.014 },
                },
                'deepseek-v4-pro': {
                    offPeak: { inputPricePerMillion: 0.66, outputPricePerMillion: 1.98, cacheReadPricePerMillion: 0.022 },
                    peak: { inputPricePerMillion: 1.32, outputPricePerMillion: 3.96, cacheReadPricePerMillion: 0.044 },
                },
            },
        },
        'deepseek-official': {
            currency: 'CNY',
            models: {
                'deepseek-v4-flash': {
                    offPeak: { inputPricePerMillion: 1.5, outputPricePerMillion: 4.5, cacheReadPricePerMillion: 0.05 },
                    peak: { inputPricePerMillion: 3.0, outputPricePerMillion: 9.0, cacheReadPricePerMillion: 0.10 },
                },
                'deepseek-v4-pro': {
                    offPeak: { inputPricePerMillion: 4.5, outputPricePerMillion: 13.5, cacheReadPricePerMillion: 0.15 },
                    peak: { inputPricePerMillion: 9.0, outputPricePerMillion: 27.0, cacheReadPricePerMillion: 0.30 },
                },
            },
        },
    },
};
/** Whether a UTC timestamp falls in any peak window. */
function isPeakHour(ms, windows) {
    const hour = new Date(ms).getUTCHours();
    return windows.some(w => hour >= w.start && hour < w.end);
}
function resolveConfig(config) {
    const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV);
    const baseURL = (config.baseURL ?? process.env.DEEPSEEK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const balancePath = config.balancePath ?? DEFAULT_BALANCE_PATH;
    if (!balancePath.startsWith('/')) {
        throw new TypeError('dsh-usage-balance-meter: balancePath must start with "/"');
    }
    if (config.usagePath !== undefined && !config.usagePath.startsWith('/')) {
        throw new TypeError('dsh-usage-balance-meter: usagePath must start with "/"');
    }
    const prices = config.inputPricePerMillion === undefined
        && config.outputPricePerMillion === undefined
        && config.cacheReadPricePerMillion === undefined
        && config.cacheWritePricePerMillion === undefined
        ? undefined
        : {
            inputPricePerMillion: config.inputPricePerMillion ?? 0,
            outputPricePerMillion: config.outputPricePerMillion ?? 0,
            cacheReadPricePerMillion: config.cacheReadPricePerMillion ?? 0,
            cacheWritePricePerMillion: config.cacheWritePricePerMillion ?? 0,
        };
    const balanceAdapters = new Map();
    for (const adapter of config.balanceProviders ?? []) {
        if (!adapter.path.startsWith('/')) {
            throw new TypeError(`dsh-usage-balance-meter: balanceProvider "${adapter.provider}" path must start with "/"`);
        }
        balanceAdapters.set(adapter.provider, adapter);
    }
    const priceTable = buildResolvedPriceTable(config);
    const budgetConfig = config.budget ?? {};
    const budget = {
        enabled: budgetConfig.enabled === true,
        amount: budgetConfig.amount ?? 0,
        period: budgetConfig.period ?? 'month',
        ...budgetConfig.customStart !== undefined ? { customStart: budgetConfig.customStart } : {},
        ...budgetConfig.customEnd !== undefined ? { customEnd: budgetConfig.customEnd } : {},
    };
    const thresholdsConfig = config.thresholds ?? {};
    const thresholds = {
        warnPercent: thresholdsConfig.warnPercent ?? 80,
        errorPercent: thresholdsConfig.errorPercent ?? 100,
    };
    return {
        apiKeyEnv,
        baseURL,
        balancePath,
        ...config.usagePath === undefined ? {} : { usagePath: config.usagePath },
        ...prices === undefined ? {} : { price: prices },
        currency: config.currency ?? 'USD',
        balanceAdapters,
        budget,
        thresholds,
        prices: priceTable,
        peakWindows: config.peakWindows ?? DEFAULT_PEAK_WINDOWS,
    };
}
/**
 * Resolve the API key for one call. The credential seam is preferred; without
 * it the trusted launch environment is the whole credential plane.
 */
async function resolveApiKey(ctx, ref) {
    const credentials = ctx.get('credentials');
    if (credentials !== undefined) {
        const hit = await credentials.resolve(ref);
        if (hit !== undefined)
            return hit.value;
    }
    const ambient = launchEnvironmentOf(ctx).get(ref);
    if (ambient !== undefined && ambient.value.length > 0)
        return ambient.value;
    return undefined;
}
function zeroUsage() {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
}
function addUsage(target, u) {
    target.inputTokens += u.inputTokens;
    target.outputTokens += u.outputTokens;
    target.cacheReadTokens += u.cacheReadTokens ?? 0;
    target.cacheWriteTokens += u.cacheWriteTokens ?? 0;
    target.reasoningTokens += u.reasoningTokens ?? 0;
}
/**
 * Sum provider-reported token usage from the durable session log. We use
 * `assistant/message` events because they are the final per-step usage anchor;
 * this avoids double counting `assistant/chunk` usage-only deltas.
 */
function collectSessionUsage(events) {
    const usage = zeroUsage();
    for (const event of events) {
        if (event.type !== 'assistant/message' || event.data.usage === undefined)
            continue;
        addUsage(usage, event.data.usage);
    }
    return usage;
}
function zeroAccumulator() {
    return { calls: 0, models: new Set(), usage: zeroUsage() };
}
function addStep(acc, model, u) {
    acc.models.add(model);
    acc.calls += 1;
    addUsage(acc.usage, u);
    return acc;
}
/**
 * Aggregate per-provider usage from the current session log. Providers with no
 * recorded calls simply do not appear here; the envelope merges them with the
 * live `ctx.llm.listProviders()` set so the model sees the whole topology.
 */
function collectProviderUsage(events) {
    const byProvider = new Map();
    for (const event of events) {
        if (event.type !== 'assistant/message' || event.data.usage === undefined)
            continue;
        const provider = event.data.message.source.provider;
        const model = event.data.message.source.model;
        const acc = byProvider.get(provider) ?? zeroAccumulator();
        byProvider.set(provider, addStep(acc, model, event.data.usage));
    }
    return byProvider;
}
/** Estimated session cost from provider-reported usage, when pricing is configured. */
function estimateCost(usage, price, currency) {
    if (price === undefined)
        return null;
    const input = (usage.inputTokens / 1_000_000) * price.inputPricePerMillion;
    const output = (usage.outputTokens / 1_000_000) * price.outputPricePerMillion;
    const cacheRead = (usage.cacheReadTokens / 1_000_000) * price.cacheReadPricePerMillion;
    const cacheWrite = (usage.cacheWriteTokens / 1_000_000) * price.cacheWritePricePerMillion;
    return {
        input,
        output,
        cacheRead,
        cacheWrite,
        total: input + output + cacheRead + cacheWrite,
        currency,
    };
}
/** Convert a session usage snapshot into a ledger-compatible bucket shape. */
function toLedgerUsage(usage) {
    return {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens,
        cacheWrite: usage.cacheWriteTokens,
        reasoning: usage.reasoningTokens,
    };
}
/** Total cost (a number) for one usage snapshot under the current pricing. */
function costOfUsage(usage, price) {
    if (price === undefined)
        return 0;
    const estimate = estimateCost(usage, price, 'USD');
    return estimate?.total ?? 0;
}
/** Flat tier to bill for a timestamp under a (possibly peak/off-peak) price. */
function tierFor(price, ms, windows) {
    if (price === undefined)
        return undefined;
    if (price.peak !== undefined && price.offPeak !== undefined) {
        return isPeakHour(ms, windows) ? price.peak : price.offPeak;
    }
    if (price.inputPricePerMillion === undefined
        && price.outputPricePerMillion === undefined
        && price.cacheReadPricePerMillion === undefined
        && price.cacheWritePricePerMillion === undefined) {
        return undefined;
    }
    return price;
}
/** Cost (number) + currency for one usage snapshot at a specific timestamp. */
function costOfUsageAt(ms, usage, price, currency, windows) {
    const flat = tierFor(price, ms, windows);
    if (flat === undefined)
        return { cost: 0, currency };
    const estimate = estimateCost(usage, flat, currency);
    return { cost: estimate?.total ?? 0, currency };
}
function buildLedgerSummary(ledger, resolved) {
    const totals = ledger.totals();
    let budget = null;
    if (resolved.budget.enabled) {
        let used;
        const period = resolved.budget.period;
        const currency = resolved.currency;
        if (period === 'day')
            used = totals.today.cost[currency] ?? 0;
        else if (period === 'month')
            used = totals.month.cost[currency] ?? 0;
        else if (period === 'all')
            used = totals.all.cost[currency] ?? 0;
        else {
            const start = resolved.budget.customStart ?? localDayKey(Date.now());
            const end = resolved.budget.customEnd ?? localDayKey(Date.now());
            used = ledger.rangeTotals(start, end).cost[currency] ?? 0;
        }
        const amount = resolved.budget.amount;
        const percent = amount > 0 ? (used / amount) * 100 : 0;
        budget = {
            enabled: true,
            period: String(period),
            used,
            amount,
            percent,
            warnPercent: resolved.thresholds.warnPercent,
            errorPercent: resolved.thresholds.errorPercent,
        };
    }
    return { today: totals.today, month: totals.month, all: totals.all, budget };
}
function buildCostState(ctx, ledger, resolved) {
    const summary = buildLedgerSummary(ledger, resolved);
    return {
        currency: resolved.currency,
        today: summary.today,
        month: summary.month,
        all: summary.all,
        budget: summary.budget,
    };
}
/**
 * Perform one GET. Adds `Authorization: Bearer` unless `bearer` is false.
 * @returns parsed JSON body.
 */
async function getJson(endpoint, apiKey, signal, headers = {}, bearer = true) {
    const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
            ...(bearer ? { Authorization: `Bearer ${apiKey}` } : {}),
            Accept: 'application/json',
            ...headers,
        },
        signal,
    });
    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status} from ${endpoint}${body ? `: ${body}` : ''}`);
    }
    return response.json();
}
async function fetchOfficialBalance(baseURL, balancePath, apiKey, signal) {
    const data = await getJson(`${baseURL}${balancePath}`, apiKey, signal);
    return {
        isAvailable: data.is_available === true,
        currencies: (data.balance_infos ?? []).map((entry) => ({
            currency: entry.currency,
            totalBalance: entry.total_balance,
            grantedBalance: entry.granted_balance,
            toppedUpBalance: entry.topped_up_balance,
        })),
    };
}
/** Read a dot path (e.g. `data.balance`) from an arbitrary JSON value. */
function extractAtPath(value, path) {
    let cursor = value;
    for (const segment of path.split('.')) {
        if (cursor === null || typeof cursor !== 'object')
            return undefined;
        cursor = cursor[segment];
    }
    return cursor;
}
async function fetchCustomBalance(baseURL, adapter, apiKey, signal) {
    const endpoint = `${adapter.baseURL ?? baseURL}${adapter.path}`;
    const raw = await getJson(endpoint, apiKey, signal, adapter.headers ?? {}, (adapter.auth ?? 'bearer') !== 'none');
    const extracted = adapter.extract === undefined ? undefined : extractAtPath(raw, adapter.extract);
    return {
        adapter: 'custom',
        status: 'ok',
        ...(typeof extracted === 'number' || typeof extracted === 'string' ? { value: extracted } : {}),
        ...(adapter.currency !== undefined ? { currency: adapter.currency } : {}),
        raw: raw,
    };
}
const PROVIDER_OVERVIEW_VALUE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        providers: {
            type: 'array',
            required: true,
            items: {
                type: 'object',
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
};
/**
 * Build per-provider overview rows used by both `api_overview` and the
 * `/cost` command. Resolves the key once, aggregates the current session's
 * usage per provider, and attaches the official or configured balance.
 */
async function buildProviderOverviews(ctx, resolved, signal, events) {
    const apiKey = await resolveApiKey(ctx, resolved.apiKeyEnv);
    const usageByProvider = collectProviderUsage(events);
    return Promise.all(ctx.llm.listProviders().map(async (info) => {
        const acc = usageByProvider.get(info.id);
        const usage = acc?.usage ?? zeroUsage();
        const cost = estimateCost(usage, tierFor(priceFor(info.id, undefined, resolved), Date.now(), resolved.peakWindows), currencyFor(info.id, resolved));
        const adapter = resolved.balanceAdapters.get(info.id);
        let balance = null;
        let balanceReason;
        if (apiKey === undefined) {
            balanceReason = info.id === OFFICIAL_PROVIDER ? 'no-key' : (adapter === undefined ? 'unsupported' : 'no-key');
        }
        else if (info.id === OFFICIAL_PROVIDER && adapter === undefined) {
            try {
                const view = await fetchOfficialBalance(resolved.baseURL, resolved.balancePath, apiKey, signal);
                balance = {
                    adapter: 'official',
                    status: 'ok',
                    ...(view.currencies.length > 0 ? { currency: view.currencies[0]?.currency } : {}),
                    currencies: view.currencies,
                    raw: view,
                };
                balanceReason = 'ok';
            }
            catch {
                balance = null;
                balanceReason = 'error';
            }
        }
        else if (adapter !== undefined) {
            try {
                balance = await fetchCustomBalance(resolved.baseURL, adapter, apiKey, signal);
                balanceReason = 'ok';
            }
            catch {
                balance = null;
                balanceReason = 'error';
            }
        }
        else {
            balanceReason = 'unsupported';
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
        };
    }));
}
/** Render one provider's balance line for the `/cost` command. */
function renderBalanceLine(provider) {
    const b = provider.balance;
    if (b === null) {
        switch (provider.balanceReason) {
            case 'no-key': return 'balance: no API key configured';
            case 'error': return 'balance: query failed';
            case 'no-balance-adapter': return 'balance: no adapter configured';
            default: return 'balance: not supported';
        }
    }
    if (b.adapter === 'official' && b.currencies !== undefined) {
        const detail = b.currencies
            .map(c => `${c.currency} ${c.totalBalance} (granted ${c.grantedBalance} / topped-up ${c.toppedUpBalance})`)
            .join(', ');
        return `balance: ${detail}`;
    }
    const parts = [];
    if (b.value !== undefined)
        parts.push(String(b.value));
    if (b.currency !== undefined)
        parts.push(b.currency);
    return parts.length > 0 ? `balance: ${parts.join(' ')}` : 'balance: ok';
}
/** Human-readable `/cost` output from the same projection `api_overview` uses. */
async function renderCostCommand(ctx, resolved, invocation, signal, ledger) {
    const providers = await buildProviderOverviews(ctx, resolved, signal, invocation.agent.session.events);
    const lines = [`${BUILD_VERSION}`];
    if (providers.length === 0) {
        lines.push('No active LLM providers found.');
    }
    else {
        lines.push('Usage & balance by provider:');
        for (const p of providers) {
            const u = p.usage;
            lines.push(`• ${p.displayName} (${p.provider})`);
            lines.push(`  calls: ${p.calls} | input: ${u.inputTokens} | output: ${u.outputTokens} | cacheRead: ${u.cacheReadTokens} | cacheWrite: ${u.cacheWriteTokens}`);
            if (p.models.length > 0)
                lines.push(`  models: ${p.models.join(', ')}`);
            lines.push(`  cost: ${p.cost === null ? 'not configured' : `${p.cost.currency} ${p.cost.total.toFixed(6)}`}`);
            lines.push(`  ${renderBalanceLine(p)}`);
        }
    }
    const summary = buildLedgerSummary(ledger, resolved);
    lines.push('');
    const costLine = (t) => {
        const entries = Object.entries(t.cost);
        return entries.length === 0 ? `0 ${resolved.currency}` : entries.map(([c, v]) => `${v.toFixed(6)} ${c}`).join(', ');
    };
    lines.push('Ledger totals:');
    lines.push(`  today: calls ${summary.today.calls} | cost ${costLine(summary.today)}`);
    lines.push(`  month: calls ${summary.month.calls} | cost ${costLine(summary.month)}`);
    lines.push(`  all:   calls ${summary.all.calls} | cost ${costLine(summary.all)}`);
    if (summary.budget !== null) {
        const b = summary.budget;
        lines.push(`  budget (${b.period}): ${b.used.toFixed(6)} / ${b.amount.toFixed(6)} = ${b.percent.toFixed(1)}% (warn >= ${b.warnPercent}%, error >= ${b.errorPercent}%)`);
    }
    else {
        lines.push('  budget: disabled');
    }
    if (resolved.price === undefined && resolved.prices.default === undefined) {
        lines.push('');
        lines.push('Tip: set inputPricePerMillion/outputPricePerMillion (or configure prices) to enable cost estimates.');
    }
    return { kind: 'success', text: lines.join('\n') };
}
/** Register the plugin's tools, persistent ledger, and slash command. */
export function apply(ctx, config) {
    // Dynamic configuration: a mounted settings section can replace the source
    // function, so every operation re-resolves with the latest persisted values.
    let current = () => config;
    let lastRaw;
    let lastGood;
    const resolved = () => {
        const raw = current();
        if (raw === lastRaw && lastGood !== undefined)
            return lastGood;
        lastGood = resolveConfig(raw);
        lastRaw = raw;
        return lastGood;
    };
    resolved(); // validate the initial config eagerly
    // Persist under the workspace root when a sandbox policy is present: that
    // location is durable AND allowed under the default workspace-write file
    // policy, unlike `$DSH_HOME/storages`. In-memory is only a last-resort so
    // the plugin never blocks startup.
    const policy = ctx.get('sandboxPolicy');
    const workspaceRoot = policy?.resolve?.().workspaceRoot;
    let ledger;
    try {
        ledger = workspaceRoot !== undefined && workspaceRoot.length > 0
            ? Ledger.open(180, join(workspaceRoot, '.dsh-usage-balance-meter'))
            : Ledger.open();
    }
    catch (error) {
        ledger = Ledger.open(180, null);
        ctx.logger?.warn?.(`[usage-meter] ledger disk open failed; running with in-memory ledger: ${String(error)}`);
    }
    ctx.effect(() => () => ledger.close());
    ctx.provide?.('usageMeter', {
        async getState() {
            return buildCostState(ctx, ledger, resolved());
        },
    });
    // Capture every model call's usage from the llm/stream waterfall and account
    // it into the persistent ledger (today / month / all totals).
    ctx.on('llm/stream', (options, next) => {
        const downstream = next();
        return (async function* usageMeterStream() {
            let usage = null;
            try {
                for await (const chunk of downstream) {
                    if (chunk !== null && typeof chunk === 'object'
                        && chunk.type === 'usage'
                        && chunk.usage !== undefined) {
                        usage = chunk.usage ?? null;
                    }
                    yield chunk;
                }
            }
            finally {
                if (usage !== null) {
                    try {
                        const sessionUsage = {
                            inputTokens: usage.inputTokens,
                            outputTokens: usage.outputTokens,
                            cacheReadTokens: usage.cacheReadTokens ?? 0,
                            cacheWriteTokens: usage.cacheWriteTokens ?? 0,
                            reasoningTokens: usage.reasoningTokens ?? 0,
                        };
                        const cfg = resolved();
                        const billed = costOfUsageAt(Date.now(), sessionUsage, priceFor(options.provider, options.model, cfg), currencyFor(options.provider, cfg), cfg.peakWindows);
                        ledger.account({
                            provider: options.provider,
                            model: options.model,
                            ...options.sessionId !== undefined ? { sessionId: String(options.sessionId) } : {},
                            timestamp: Date.now(),
                            usage: toLedgerUsage(sessionUsage),
                            currency: billed.currency,
                            cost: billed.cost,
                        });
                    }
                    catch (error) {
                        ;
                        ctx.logger?.warn?.(`[usage-meter] ledger account failed: ${String(error)}`);
                    }
                }
            }
        })();
    });
    // Persist user-adjustable settings (pricing, budget, thresholds) when the
    // settings seam is composed.
    ctx.inject(['settings'], (settingsCtx) => {
        installSettingsSection(settingsCtx, SETTINGS_NS, Config, config, {
            setSource: (source) => {
                current = source;
            },
            onChange: () => {
                resolved();
            },
        });
    });
    // Surface per-session cost/tokens to the web client footer through the
    // session-projection seam.
    // Nudge the model to call the meter tools when the user asks about cost,
    // balance, usage, quota, or budget.
    ctx.inject(['systemPrompt'], (promptCtx) => {
        promptCtx.systemPrompt.section({
            name: 'tool:usage-meter',
            order: 118,
            text: 'When the user asks about DeepSeek API balance, quota, credits, token usage, cost, or budget, use the deepseek_api_status, api_overview, or usage_summary tools to read live data instead of answering from memory.',
        });
    });
    ctx.inject(['sessionProjections'], (projectionCtx) => {
        projectionCtx.sessionProjections.register({
            key: 'costUsage',
            schema: zod.object({
                input: zod.number(),
                output: zod.number(),
                cacheRead: zod.number(),
                cacheWrite: zod.number(),
                reasoning: zod.number(),
                cost: zod.number(),
            }),
            stateVersion: 1,
            init: () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 }),
            apply: (state, event) => {
                if (event.type !== 'assistant/message' || event.data.usage === undefined)
                    return state;
                const u = event.data.usage;
                const sessionUsage = {
                    inputTokens: u.inputTokens,
                    outputTokens: u.outputTokens,
                    cacheReadTokens: u.cacheReadTokens ?? 0,
                    cacheWriteTokens: u.cacheWriteTokens ?? 0,
                    reasoningTokens: u.reasoningTokens ?? 0,
                };
                const cfg = resolved();
                const cost = costOfUsageAt(Date.now(), sessionUsage, priceFor(event.data.message.source.provider, event.data.message.source.model, cfg), currencyFor(event.data.message.source.provider, cfg), cfg.peakWindows).cost;
                return {
                    input: state.input + sessionUsage.inputTokens,
                    output: state.output + sessionUsage.outputTokens,
                    cacheRead: state.cacheRead + sessionUsage.cacheReadTokens,
                    cacheWrite: state.cacheWrite + sessionUsage.cacheWriteTokens,
                    reasoning: state.reasoning + sessionUsage.reasoningTokens,
                    cost: state.cost + cost,
                };
            },
            view: state => state,
        });
    });
    ctx.tools.register(defineTool({
        name: 'deepseek_api_status',
        description: 'Read the currently connected DeepSeek API account balance and the current session token usage. '
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
            const cfg = resolved();
            const apiKey = await resolveApiKey(ctx, cfg.apiKeyEnv);
            if (apiKey === undefined) {
                throw new Error(`No DeepSeek API key found for "${cfg.apiKeyEnv}". Store it through the credentials service or export it in the environment.`);
            }
            const usage = collectSessionUsage(exec.agent?.session.events ?? []);
            const cost = estimateCost(usage, cfg.price, cfg.currency);
            let accountUsage = null;
            if (cfg.usagePath !== undefined) {
                accountUsage = await getJson(`${cfg.baseURL}${cfg.usagePath}`, apiKey, exec.signal);
            }
            const balance = await fetchOfficialBalance(cfg.baseURL, cfg.balancePath, apiKey, exec.signal);
            return {
                balance,
                usage,
                accountUsage,
                cost,
                baseURL: cfg.baseURL,
            };
        },
        presentCall: () => ({ card: 'generic', title: 'Check DeepSeek API status', kind: 'read' }),
    }));
    ctx.tools.register(defineTool({
        name: 'api_overview',
        description: 'List every active LLM provider with its current session call count, token usage, '
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
            const cfg = resolved();
            const providers = await buildProviderOverviews(ctx, cfg, exec.signal, exec.agent?.session.events ?? []);
            return { providers };
        },
        presentCall: () => ({ card: 'generic', title: 'List provider usage & balance', kind: 'read' }),
    }));
    ctx.tools.register(defineTool({
        name: 'usage_summary',
        description: 'Read the persistent cost ledger totals (today / this month / all time) and the '
            + 'budget status, across all sessions. Use this when the user asks how much has been '
            + 'spent in total, today, this month, or against a budget.',
        parameters: {},
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    currency: { type: 'string', required: true },
                    totals: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                            today: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    calls: { type: 'number', required: true },
                                    input: { type: 'number', required: true },
                                    output: { type: 'number', required: true },
                                    cacheRead: { type: 'number', required: true },
                                    cacheWrite: { type: 'number', required: true },
                                    reasoning: { type: 'number', required: true },
                                    cost: { type: 'object', required: true, additionalProperties: true },
                                },
                            },
                            month: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    calls: { type: 'number', required: true },
                                    input: { type: 'number', required: true },
                                    output: { type: 'number', required: true },
                                    cacheRead: { type: 'number', required: true },
                                    cacheWrite: { type: 'number', required: true },
                                    reasoning: { type: 'number', required: true },
                                    cost: { type: 'object', required: true, additionalProperties: true },
                                },
                            },
                            all: {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    calls: { type: 'number', required: true },
                                    input: { type: 'number', required: true },
                                    output: { type: 'number', required: true },
                                    cacheRead: { type: 'number', required: true },
                                    cacheWrite: { type: 'number', required: true },
                                    reasoning: { type: 'number', required: true },
                                    cost: { type: 'object', required: true, additionalProperties: true },
                                },
                            },
                        },
                    },
                    budget: {
                        oneOf: [
                            {
                                type: 'object',
                                additionalProperties: false,
                                properties: {
                                    enabled: { type: 'boolean', required: true },
                                    period: { type: 'string', required: true },
                                    used: { type: 'number', required: true },
                                    amount: { type: 'number', required: true },
                                    percent: { type: 'number', required: true },
                                    warnPercent: { type: 'number', required: true },
                                    errorPercent: { type: 'number', required: true },
                                },
                            },
                            { type: 'null' },
                        ],
                    },
                    providers: {
                        type: 'array',
                        required: true,
                        items: { type: 'object', additionalProperties: true },
                    },
                },
            },
            render: (_args, value) => [{
                    type: 'text',
                    text: JSON.stringify(value),
                }],
        },
        async execute(_args, exec) {
            const cfg = resolved();
            const summary = buildLedgerSummary(ledger, cfg);
            const providers = await buildProviderOverviews(ctx, cfg, exec.signal, exec.agent?.session.events ?? []);
            return {
                currency: cfg.currency,
                totals: { today: summary.today, month: summary.month, all: summary.all },
                budget: summary.budget,
                providers: providers.map(p => ({ provider: p.provider, displayName: p.displayName, calls: p.calls, cost: p.cost?.total ?? 0 })),
            };
        },
        presentCall: () => ({ card: 'generic', title: 'Read cost ledger summary & budget', kind: 'read' }),
    }));
    ctx.inject?.(['commands'], (commandCtx) => {
        commandCtx.commands.register({
            name: 'cost',
            description: 'show current session usage, cost, balance, and ledger totals by provider',
            handler: (invocation) => renderCostCommand(ctx, resolved(), invocation, invocation.signal, ledger),
        });
    });
}
