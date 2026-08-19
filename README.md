# dsh-usage-balance-meter

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that registers two model-facing tools:

- `deepseek_api_status` — reads the currently connected DeepSeek API account balance (`GET /user/balance`), the current session's provider-reported token usage, an optional gateway account-usage response, and an optional session cost estimate.
- `api_overview` — lists every active LLM provider (`ctx.llm.listProviders()`) with per-provider call counts, token usage, models used, cost estimate, and balance status (DeepSeek official out of the box; other providers marked `unsupported` until a balance adapter is configured).

This is a host-only plugin — no client bundle yet. It depends only on `ctx.tools` and, optionally, `ctx.credentials`.

## Install (from a dsh environment)

```sh
dsh plugin --profile web add dsh-usage-balance-meter
# or from a local checkout:
dsh plugin --profile web add link:/absolute/path/to/dsh-usage-balance-meter
```

Then restart `dsh web` (plugin rows and bundles are scanned at startup).

## Config

```yaml
- id: usage-meter
  name: dsh-usage-balance-meter
  config:
    apiKeyEnv: DEEPSEEK_API_KEY        # default; resolved through ctx.credentials, then env
    baseURL: https://api.deepseek.com  # optional; $DEEPSEEK_BASE_URL then public API
    balancePath: /user/balance         # optional
    # usagePath: /usage                # only if your gateway exposes one
    # inputPricePerMillion: 0.50
    # outputPricePerMillion: 2.00
    # cacheReadPricePerMillion: 0.25
    # cacheWritePricePerMillion: 0.25
    # currency: USD
    # Optional per-provider HTTP balance adapters (for gateways / non-official providers):
    # balanceProviders:
    #   - provider: openai
    #     baseURL: https://api.openai.com   # optional; defaults to plugin baseURL
    #     path: /v1/dashboard/billing/credit_grants
    #     headers: {}                        # optional
    #     auth: bearer                       # bearer | none
    #     extract: grants.0.error            # optional dot-path into the JSON response
    #     currency: USD
```

## Tool output shape

The `deepseek_api_status` tool returns an object with:

- `balance` — normalized DeepSeek balance (`isAvailable` + per-currency totals).
- `usage` — session token buckets (input/output/cache/reasoning).
- `accountUsage` — raw gateway usage response, or `null`.
- `cost` — estimated session cost, or `null` when no pricing is configured.
- `baseURL` — the resolved API base URL.

## `api_overview` output shape

The `api_overview` tool returns an object with one `providers` entry per
active provider:

- `provider` / `displayName` — route id and display name from `ctx.llm.listProviders()`.
- `calls` — number of model calls with recorded usage in the current session.
- `models` — distinct model ids used by that provider.
- `usage` — token buckets (input/output/cache/reasoning).
- `cost` — estimated cost, or `null` when no pricing is configured.
- `balance` — balance info for the provider:
  - `deepseek-official` uses the built-in official adapter (`adapter: "official"` with `currencies`).
  - A provider with a configured `balanceProviders` entry uses the custom HTTP adapter (`adapter: "custom"` with optional `value`/`currency`/`raw`).
  - Otherwise `null`.
- `balanceReason` — `ok` | `no-key` | `error` | `unsupported`.

## Slash command

`/cost` prints the same projection `api_overview` returns, as human-readable text:

```
• DeepSeek (deepseek-official)
  calls: 2 | input: 17 | output: 9 | cacheRead: 3 | cacheWrite: 0
  models: deepseek-v4-flash
  cost: USD 0.000025
  balance: CNY 12.34 (granted 1.00 / topped-up 11.34)
```

It is registered only when a `commands` service is composed (interactive UI);
in headless assemblies the tools still work.

## Development

```sh
npm install
npm run build   # tsc -> lib/
npm test        # vitest
```

## Roadmap

- ~~Per-provider usage aggregation~~ (done in `api_overview`)
- ~~Per-provider balance adapters~~ (done: official built-in + configurable HTTP adapters)
- ~~`/cost` slash command~~ (done)
- ~~Persistent ledger (today / month / cumulative)~~ (done: `usage_summary` + `/cost`)
- ~~Lightweight settings persistence (pricing, budget, thresholds)~~ (done)
- ~~Minimal Web UI footer~~ (scaffold shipped under `client/`, experimental — verify against a live Harness web build)
