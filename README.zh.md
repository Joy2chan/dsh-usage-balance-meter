# dsh-usage-meter

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的插件：注册两个模型可调用的工具：

- `deepseek_api_status` — 读取当前接入的 DeepSeek API 账户余额（`GET /user/balance`）、当前会话的提供方 token 用量、可选的网关账户级用量响应、可选的会话费用估算。
- `api_overview` — 列出所有 active LLM provider（`ctx.llm.listProviders()`），给出每个 provider 的调用次数、token 用量、所用模型、费用估算和余额状态（DeepSeek 官方开箱即用；其他 provider 在配置余额适配器前标记为 `unsupported`）。

目前是纯宿主插件（还没有客户端 bundle），只依赖 `ctx.tools`，以及可选的 `ctx.credentials`。

## 安装（在 dsh 环境里）

```sh
dsh plugin --profile web add dsh-usage-meter
# 或本地调试：
dsh plugin --profile web add link:/绝对路径/dsh-usage-meter
```

然后重启 `dsh web`（插件行与 bundle 会在启动时扫描）。

## 配置

```yaml
- id: usage-meter
  name: dsh-usage-meter
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

## 开发

```sh
npm install
npm run build   # tsc -> lib/
npm test        # vitest
```

## 路线图（规划中，尚未实现）

- `/cost` 斜杠命令
- ~~按 provider 聚合用量~~（已在 `api_overview` 实现）
- ~~按 provider 的余额适配器~~（已实现：官方内置 + 可配置 HTTP 适配器）
- 按 provider 的余额适配器（DeepSeek 官方开箱即用；网关可配置 HTTP 端点）
- 轻量设置持久化（价格、预算、阈值）
- 可选的最小化 Web UI footer
