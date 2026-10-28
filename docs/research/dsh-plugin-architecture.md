# DSH 插件架构调查

> 调查日期：2026-10-28。只读调查，未修改任何 DSH 安装或用户 profile。
> 结论均来自已发布 npm 包的 `README.md` / `.d.ts`，对应版本见下表。

## 1. 产品与版本

| 项 | 值 | 证据 |
|---|---|---|
| 产品名 | DeepSeek Harness（简称 DSH） | `/Applications/DeepSeek Harness.app` |
| App 版本 | `0.2.1-rc.3` | `Info.plist` `CFBundleShortVersionString` |
| 插件框架 | `@deepseek-ai/cordis` `~4.0.5`（Koishi 系 cordis fork） | `dsh-subagent-codex@0.2.1-rc.3` 的 `peerDependencies` |
| SDK 包 | `@deepseek-ai/dsh-*@0.2.1-rc.3`（npm，镜像 `registry.npmmirror.com`） | `npm view` |
| 上游仓库 | `github.com/deepseek-ai/deepseek-harness`（MIT） | 包 `repository` 字段 |
| 运行时 | Node.js ESM（`"type": "module"`），TypeScript 编译为 `lib/index.js` + `lib/types/*.d.ts` | 第三方插件包结构 |

本机 `~/.npm/_npx/.../@deepseek-ai/*` 另有一套 `0.1.5-rc.2` 的旧包；与 `0.2.1-rc.3` 对比，`LlmAdapter`、`ctx.credentials`、`ctx.authorization` 的变更都是**增量**（新增 `imageRequestTarget`、`ToolUpdate`、`AuthorizationSession.commit`），核心契约稳定。**本插件以 0.2.1-rc.3 为编译与兼容目标。**

## 2. 插件发现、加载、配置、卸载

- **Profile**：`~/.dsh/profiles/<name>/` 是一个 pnpm 工作区（`nodeLinker: hoisted`）。
  - `package.json`：`dependencies` 声明要安装的插件包；`dsh.profile.bundles` 列出要叠加的 bundle。
  - `cordis.yml`：根条目列表（默认 `[]`，不应手改）。
  - `cordis.patch.yml`：用户补丁层，按 `id` 插入（`insert`）、覆盖配置或禁用插件条目。
- **Bundle**：插件包在自身 `package.json` 中声明 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`，其 patch 用 `- insert: [{ id, name, config }]` 把插件挂进加载树。范例：`@deepseek-ai/dsh-subagent-codex`。
- **插件入口**：标准 cordis 插件模块，导出 `name`、`inject`（依赖的服务名数组）、`Config`（schemastery 模式）、`apply(ctx, config)`。`apply` 内注册的一切（adapter、flow、listener）挂在插件的 fiber 上，**插件被卸载/禁用时自动 dispose**。
- **安装**：把包加入 profile 的 `dependencies` + `dsh.profile.bundles`（或在 `cordis.patch.yml` 中 `insert`），由 DSH 的 plugin-manager 执行 pnpm 安装（`~/.dsh/profiles/desktop/.plugin-manager/`）。
- **卸载**：从 `bundles`/`dependencies` 移除。插件 fiber dispose 时，注册的 adapter 路由和 auth flow 自动撤销；**凭证记录不会自动删除**（见 §5）。
- **隔离**：插件与 DSH 宿主运行在**同一 Node 进程**中（cordis host runner），无沙箱。插件拥有宿主进程全部权限，因此插件代码本身是信任边界的一部分。

## 3. LLM Provider 接口（`@deepseek-ai/dsh-llm`）

- 服务：`ctx.llm: LlmRuntime`。
- 注册：`ctx.llm.registerAdapter(providers: string[], adapter: LlmAdapter)` → 返回 disposer（随 fiber 自动释放）。重复路由报 `DUPLICATE_ADAPTER`。
- 可配置 provider 目录：`ctx.llm.registerConfigurableProviders([...])`，让设置 UI 列出该 provider。
- `abstract class LlmAdapter`：
  - `stream(options: GenerateOptions): AsyncIterable<StreamChunk>` —— **唯一必须实现的方法**，必须遵守 `options.signal`。
  - `providerInfo(provider)`、`listModels(provider)`、`resolveModel(provider, model, signal)`、`prepareCall(...)`、`providerRetryPolicy(provider)`、`imageRequestTarget(...)` 有默认实现，可覆盖。
  - 0.2.1 起：**GUI 等基于目录的入口可能要求模型出现在 `listModels()` 中**，所以 adapter 必须广告可用模型。
- `GenerateOptions`：`provider, model, reasoningEffort?, messages, system?, tools?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose?`。
- 消息内容块：`text | reasoning | image | file | tool-call | tool-result`。`file` 永不到达 adapter（宿主替换为文本句柄）。
- `StreamChunk` 协议：`block-start → (text-delta | reasoning-delta | tool-call-delta)* → block-end`，然后 `usage`，最后**恰好一个** `finish`（`stop | tool-calls | max-tokens | aborted | error`）。工具参数保持原始 JSON 字符串。
- 错误：抛出 `LlmError(message, code, { status, providerRetryAfterMs, requestId })`；运行时将抛出值规范化为终止 `finish{kind:'error'}`。已定义的规范 code：`AUTH`、`RATE_LIMIT`、`QUOTA`、`CONTEXT_WINDOW_EXCEEDED`、`EMPTY_RESPONSE`、`INVALID_CREDENTIAL`、`MISSING_CREDENTIAL` 等。
- **重试不在 adapter 内执行**：adapter 只声明 `providerRetryPolicy`，`dsh-llm-retry` 在 agent-step 边界执行。adapter 每次 `stream` 只做一次 provider 尝试。
- **Attribution**：`LlmAdapter` 契约要求每个 provider HTTP 请求带上 `attributionHeaders()`（来自 `@deepseek-ai/dsh-llm`）。
- 取消：`options.signal` 中止 → 运行时产出 `finish{kind:'aborted'}`。

## 4. 授权流程接口（`@deepseek-ai/dsh-authorization`）

- 服务：`ctx.authorization`。插件通过 `registerFlow({ key, label, methods, run(session) })` 注册一个人工授权流程，按 `<scope>/<id>` 凭证记录键标识。
- `AuthorizationSession`：`method`、`signal`、`commit(record)`、`notify({message, url?, code?})`、`prompt({kind:'text'|'secret'|'select', ...})`。
- `run()` 必须在 resolve 前通过 `session.commit` / `ctx.credentials.modifyRecord` 提交记录，否则 `NOT_COMMITTED`。每个 key 同时只允许一个尝试（`ALREADY_IN_FLIGHT`）。用户拒绝 → `AuthorizationDeclinedError` → 结果 `cancelled`。
- 设置 UI 渲染所有已注册 flow（"Sign in" 按钮），headless 组合下 interaction 直接 decline。
- `notify` 的消息**不得**携带秘密（seam 明确约定）。

## 5. 凭证存储（`@deepseek-ai/dsh-credentials` + `dsh-credentials-local`）

- 服务：`ctx.credentials`。两类键空间：
  - `CredentialRef`（环境变量名风格，存 API key）；
  - `CredentialKey` = `<scope>/<id>`，存**记录** `{ kind: 'api-key', ... } | { kind: 'grant', payload: unknown }`。
- `grant` 记录的 `payload` 对宿主完全不透明，只有所属插件能解释。
- `modifyRecord(key, mutate)` 是唯一写路径：在**独占**区间内读-改-写，**跨进程互斥**（后端支持时）——正好满足 SIWC "serialize refreshes so two processes do not race a rotating token" 的要求。
- `describeRecord` / `listRecords` 只返回元数据，从不返回值；配置 UI 可列出并删除遗留记录（包括已卸载插件留下的记录）。
- 本地后端：`~/.dsh/.credentials.yaml`，权限 `0600`，经 `dsh-atomic-write` 原子写入。**不是 OS 钥匙串。**

## 6. 模型列表、流式、工具、错误、取消的处理位置

| 关注点 | DSH 中的归属 |
|---|---|
| 模型列表 | `LlmAdapter.listModels` / `resolveModel`（上下文窗口、输入模态、推理档位） |
| 流式输出 | adapter 产出 `StreamChunk`；`BlockAssembler` 组装 |
| 工具调用 | 请求中 `tools: ToolSchema[]`；响应 `tool-call` 块；历史中 `tool-result` 块 |
| 错误 | `LlmError.code` 分类；终止 `finish` |
| 取消 | `GenerateOptions.signal` |
| 重试 | `providerRetryPolicy` + `dsh-llm-retry` |

## 7. 现有参考实现

- `@deepseek-ai/dsh-llm-pi-ai`：DSH 官方的多 provider adapter（基于 `@earendil-works/pi-ai`），已内置 `openai-codex` 路由（**传统 Codex OAuth**，与 SIWC 不同）。用户当前 desktop profile 正在使用它。本插件**不依赖、不复制**其实现，仅参考其使用的公共 seam（`ctx.credentials` 记录 + `ctx.authorization` flow），这是 DSH 文档推荐的模式。
- `@deepseek-ai/dsh-llm-deepseek`：直接 fetch + SSE 的 adapter，可作为"无第三方 LLM 库"写法的参考。

## 8. 构建与测试工具

DSH 的 SDK 包未随附可复用的测试/lint 配置。本插件自带：TypeScript（`tsc` 类型检查与构建）、`vitest`（单元与集成测试）、pnpm（锁定依赖，`pnpm-lock.yaml`）。

## 9. 对本插件的影响

1. 插件形态：一个 cordis 插件包，`inject: ['llm', 'credentials', 'authorization']`。
2. 登录 → `ctx.authorization.registerFlow`；凭证 → `ctx.credentials` 的 `grant` 记录；推理 → `LlmAdapter`。
3. **不修改 DSH 核心**：全部通过公共 seam 完成。
4. 由于 DSH 的 agent loop 几乎每次请求都携带 `tools`，工具调用实际上是 P0 可用性的前提，而非 P1 的可选项。
