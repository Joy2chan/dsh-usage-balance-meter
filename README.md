# dsh-usage-meter

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets the model call a `deepseek_api_status` tool to read:

- the currently connected DeepSeek API account balance (`GET /user/balance`),
- the current session's provider-reported token usage,
- an optional account-level usage response (configurable gateway endpoint),
- an optional session cost estimate (configurable per-million token prices).

This is a host-only plugin — no client bundle yet. It depends only on `ctx.tools` and, optionally, `ctx.credentials`.

## Install (from a dsh environment)

```sh
dsh plugin --profile web add dsh-usage-meter
# or from a local checkout:
dsh plugin --profile web add link:/absolute/path/to/dsh-usage-meter
```

Then restart `dsh web` (plugin rows and bundles are scanned at startup).

## Config

```yaml
- id: usage-meter
  name: dsh-usage-meter
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
```

## Tool output shape

The `deepseek_api_status` tool returns an object with:

- `balance` — normalized DeepSeek balance (`isAvailable` + per-currency totals).
- `usage` — session token buckets (input/output/cache/reasoning).
- `accountUsage` — raw gateway usage response, or `null`.
- `cost` — estimated session cost, or `null` when no pricing is configured.
- `baseURL` — the resolved API base URL.

## Development

```sh
npm install
npm run build   # tsc -> lib/
npm test        # vitest
```

## Roadmap (planned, not yet implemented)

- `/cost` slash command
- Per-provider usage aggregation (all active `ctx.llm` providers, call counts + tokens)
- Per-provider balance adapters (DeepSeek official out of the box; configurable HTTP endpoints for gateways)
- Lightweight settings persistence (pricing, budget, thresholds)
- Optional minimal Web UI footer
