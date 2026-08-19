# dsh-usage-balance-meter

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件：注册两个模型可调用的工具：

- `deepseek_api_status` — 读取当前接入的 DeepSeek API 账户余额（`GET /user/balance`）、当前会话的提供方 token 用量、可选的网关账户级用量响应、可选的会话费用估算。
- `api_overview` — 列出所有 active LLM provider（`ctx.llm.listProviders()`），给出每个 provider 的调用次数、token 用量、所用模型、费用估算和余额状态（DeepSeek 官方开箱即用；其他 provider 在配置余额适配器前标记为 `unsupported`）。

目前是纯宿主插件（还没有客户端 bundle），只依赖 `ctx.tools`，以及可选的 `ctx.credentials`。

## 安装（在 dsh 环境里）

```sh
dsh plugin --profile web add dsh-usage-balance-meter
# 或本地调试：
dsh plugin --profile web add link:/绝对路径/dsh-usage-balance-meter
```

然后重启 `dsh web`（插件行与 bundle 会在启动时扫描）。

## 配置

```yaml
- id: usage-meter
  name: dsh-usage-balance-meter
  config:
    apiKeyEnv: DEEPSEEK_API_KEY        # 默认；走 ctx.credentials，其次环境变量
    baseURL: https://api.deepseek.com  # 可选；省略时用 $DEEPSEEK_BASE_URL 再退回公共 API
    balancePath: /user/balance         # 可选
    # usagePath: /usage                # 仅在网关提供账户用量端点时配置
    # inputPricePerMillion: 0.50
    # outputPricePerMillion: 2.00
    # cacheReadPricePerMillion: 0.25
    # cacheWritePricePerMillion: 0.25
    # currency: USD
    # 可选：非官方 provider 的 HTTP 余额适配器（网关 / LiteLLM 等）
    # 按 provider / 按模型分别配价（未命中时回退到上面的全局价）：
    # prices:
    #   default:
    #     inputPricePerMillion: 0.50
    #     outputPricePerMillion: 2.00
    #     cacheReadPricePerMillion: 0.50
    #     cacheWritePricePerMillion: 0.25
    #   providers:
    #     opencode-go:
    #       default:
    #         inputPricePerMillion: 0.40
    #         outputPricePerMillion: 1.60
    #       models:
    #         deepseek-v4-flash:
    #           inputPricePerMillion: 0.50
    #           outputPricePerMillion: 2.00
    #           offPeak: { inputPricePerMillion: 1.5, outputPricePerMillion: 4.5, cacheReadPricePerMillion: 0.05 }
    #           peak:    { inputPricePerMillion: 3.0, outputPricePerMillion: 9.0, cacheReadPricePerMillion: 0.10 }
    #       currency: USD
    # balanceProviders:
    #   - provider: openai
    #     baseURL: https://api.openai.com   # 可选；默认使用插件 baseURL
    #     path: /v1/dashboard/billing/credit_grants
    #     headers: {}                        # 可选
    #     auth: bearer                       # bearer | none
    #     extract: grants.0.error            # 可选：JSON 响应里的点路径
    #     currency: USD
```

## 工具返回结构

`deepseek_api_status` 返回一个对象：

- `balance` — 归一化的 DeepSeek 余额（`isAvailable` + 各币种明细）
- `usage` — 会话 token 桶（输入/输出/缓存/reasoning）
- `accountUsage` — 网关原始用量响应，或 `null`
- `cost` — 会话费用估算，未配置价格时为 `null`
- `baseURL` — 解析后的 API 基础地址

## `api_overview` 返回结构

`api_overview` 返回一个对象，`providers` 数组里每个 active provider 一项：

- `provider` / `displayName` — 来自 `ctx.llm.listProviders()` 的路由 id 与显示名。
- `calls` — 当前会话中有用量记录的模型调用次数。
- `models` — 该 provider 用到的不同模型 id。
- `usage` — token 桶（输入/输出/缓存/reasoning）。
- `cost` — 费用估算，未配置价格时为 `null`。
- `balance` — 该 provider 的余额信息：
  - `deepseek-official` 使用内置官方适配器（`adapter: "official"`，带 `currencies`）。
  - 配置了 `balanceProviders` 的 provider 使用自定义 HTTP 适配器（`adapter: "custom"`，可选 `value`/`currency`/`raw`）。
  - 否则为 `null`。
- `balanceReason` — `ok` | `no-key` | `error` | `unsupported`。

## 斜杠命令

`/cost` 会把 `api_overview` 同一份投影以可读文本打印出来：

```
• DeepSeek (deepseek-official)
  calls: 2 | input: 17 | output: 9 | cacheRead: 3 | cacheWrite: 0
  models: deepseek-v4-flash
  cost: USD 0.000025
  balance: CNY 12.34 (granted 1.00 / topped-up 11.34)
```

只有在组合中存在 `commands` 服务（交互式 UI）时注册；headless 组装里工具仍可用。

## 内置默认价

插件已内置 DeepSeek 价格表（谷时/峰时两档）：

- `opencode-go` → USD 价（DeepSeek V4 Flash / V4 Pro）
- `deepseek-official` → CNY 价（DeepSeek V4 Flash / V4 Pro）

所以**不需要配 `prices` 也能算真实费用**。如果你设置了顶层的
`inputPricePerMillion`/`outputPricePerMillion`，该全局价会替换内置表。
只有你的 Harness 里**已配置/已挂载**的 provider（来自 `ctx.llm.listProviders()`）才会显示，
没有配置的 provider 即使默认表里有价也不会出现。

## 计价说明

- 账本成本**按币种分开存储**，不同币种不会被加在一起。
- 顶层 `currency` 用于预算/显示，也是没配币种 provider 的兜底。
- `peakWindows` 默认是 DeepSeek 的 UTC 峰时段（01:00–04:00、06:00–10:00），可自行修改。

## 开发

```sh
npm install
npm run build   # tsc -> lib/
npm test        # vitest
```

## 路线图

- ~~按 provider 聚合用量~~（已在 `api_overview` 实现）
- ~~按 provider 的余额适配器~~（已实现：官方内置 + 可配置 HTTP 适配器）
- ~~`/cost` 斜杠命令~~（已实现）
- ~~持久化账本（今日 / 本月 / 累计）~~（已实现：`usage_summary` + `/cost`）
- ~~轻量设置持久化（价格、预算、阈值）~~（已实现）
- ~~最小化 Web UI footer~~（已在 `client/` 放下脚手架，实验性——需在真实 Harness Web 构建中验证）
