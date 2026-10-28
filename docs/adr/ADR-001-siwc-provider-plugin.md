# ADR-001：以独立 DSH 插件实现 OpenAI SIWC Provider

- 状态：已接受（2026-10-28）
- 依据：[`docs/research/dsh-plugin-architecture.md`](../research/dsh-plugin-architecture.md)、[`docs/research/openai-siwc-protocol.md`](../research/openai-siwc-protocol.md)

## 背景

目标是在 DeepSeek Harness（DSH 0.2.1-rc.3）中用 ChatGPT 账号，通过 OpenAI 官方 SIWC（"ChatGPT plan usage for open-source"）调用模型。DSH 内置的 `dsh-llm-pi-ai` `openai-codex` 路由用的是**传统 Codex OAuth**（固定的 Codex CLI client、ChatGPT backend 端点），不是 SIWC；已知的社区实现同样基于传统 Codex OAuth。因此需要独立实现。

## 决策

### D1 形态：独立 cordis 插件包 `dsh-openai-siwc`，零核心改动

- 注册名（cordis `name`，同时是凭证记录 scope）：`openai-siwc`；provider 路由：`openai-siwc`。
- `inject: ['llm', 'credentials', 'authorization']`；可选的 `/siwc` 命令通过嵌套 `ctx.inject(['commands'], …)` 挂载（cordis 4 无可选注入）。
- 随包提供 `cordis.patch.yml`（`dsh.bundle.patch`），安装 = 加入 profile 的 `dependencies` + `dsh.profile.bundles`；卸载 = 移除。

### D2 登录：`ctx.authorization` flow + 回环回调

- 单一方法 `oauth`，标签 **Continue with ChatGPT**（UIUX 要求）。
- 回调监听只绑 `127.0.0.1`、OS 分配端口、只接受 `GET /auth/callback`，校验 `Host` 头（防 DNS rebinding），state 用常量时间比较；不匹配的请求返回 400 并**继续等待**（防止第三方用伪造回调中断真实登录）；首个有效回调后立即关闭；10 分钟超时；`session.signal` 中止即关闭。
- **触发入口**：DSH 0.2.1 的设置界面没有给第三方 `ctx.authorization` flow 提供按钮（只有 DeepSeek 账号有专门的 UI）。因此登录入口是 `/siwc login [new]`：它通过 `ctx.authorization.begin()` 运行同一个已注册的 flow（保留 DSH 的单尝试约束和提交确认），收到授权 URL 的 notice 后直接用 `open`/`xdg-open`/`rundll32` 打开**系统浏览器**（官方要求；URL 作为单个 argv 参数传入，不经过 shell），因此 URL 不会出现在命令输出和会话日志中。flow 仍然注册在 `ctx.authorization` 上，将来 DSH 提供通用 UI 时可以直接使用。
- 授权 URL 通过 `session.notify({ url })` 传给发起方（`/siwc login` 或将来的 UI）。**不发送 `id_token_hint`**（官方标注为可选）：notice 会进入 UI 层，避免把 ID token 放进 URL；重授权只发 `login_hint`（email）。代价：回访时用户会多看到一次账号选择页。
- `agent_name_hint = "DSH OpenAI SIWC"`（官方要求使用应用的真实名称，且各安装保持一致），仅首次注册发送。
- `ext_agent_host_id = urn:uuid:<UUIDv4>`，首次登录前生成并持久化，登出不删除。
- 浏览器端拒绝（`error=access_denied`）：校验 state 后停止，不换码。DSH 只把**交互 prompt** 的拒绝算作 `cancelled`，flow 自己无法声明"被拒绝"，所以这次尝试会以失败结束；错误消息按官方要求给出两个选择："重新登录并允许 plan usage"或"改用其他计费方式（如自己的 API key）"。用户在账号选择 prompt 中取消则结果为 `cancelled`。
- 已保存账号时，flow 先用 `select` prompt 让用户选择已保存账号或"使用其他 ChatGPT 账号"（对应官方的账号选择要求）；同一时刻只有一个活动 session。若新登录的是另一个账号，会先尽力撤销旧账号的 refresh token。

### D3 凭证：DSH 凭证 seam（不使用 OS 钥匙串）

两条记录，格式由本插件定义（`grant` payload，带 `version`）：

| 键 | 内容 | 生命周期 |
|---|---|---|
| `openai-siwc/registry` | `hostId`；已注册账号 `{ clientId, subject, email }` | 登出保留；只有用户在 DSH 设置中删除才消失 |
| `openai-siwc/session` | 当前账号的 `clientId, subject, email, idToken, accessToken, refreshToken, expiresAt, scopes, savedAt, earliestRefreshAt?` | flow 写入；登出删除 |

- 后端 `~/.dsh/.credentials.yaml`：`0600` + 原子写，满足官方存储要求；`modifyRecord` 跨进程独占 → 刷新串行化（官方要求）。
- 记录存在 = 已登录，所以 flow 的 key 是 `openai-siwc/session`。
- 权衡：不是钥匙串；任何能以用户身份读 `~/.dsh` 的进程都能读到 token。官方文档本身要求的就是 `0600` 文件，此风险已记录在威胁模型中。

### D4 推理：直接 `fetch` + `eventsource-parser`，不引入 OpenAI SDK

- 端点固定为官方 `https://api.openai.com/v1/{models,responses}` 和 `https://auth.openai.com/...`，**不可通过插件配置修改**（防止配置被篡改后把 token 发往第三方）；测试通过内部构造参数注入 mock 地址。
- 请求体：`model, instructions?, input, tools?, store:false, stream:true`，此外什么都不发。
- 消息映射：
  - 首条 `system` 消息 + `options.system` → `instructions`（不发 system role 项）；
  - 非首位的 `system` 消息 → `role:"developer"` 消息。DSH 0.2.1 的 `developer` 消息只用来携带工具增删；对于不声明 `toolUpdate` 的路由（本插件就是），SDK 的 `projectToolUpdates` 会**全部移除**它们（`withoutDeveloperMessages`），所以不会到达 adapter，也不会丢失模型可见的上下文；
  - `user` → `input_text`；图片经 `projectImagesForTextModel` 变成占位文本（模型声明为纯文本，见 D5）；
  - `assistant` 文本 → `output_text` 消息；`tool-call` → `function_call`（带 `namespace`）；`reasoning` 块不回放（store=false 且无加密推理内容）；
  - `tool` → `function_call_output`（文本输出）。
- 工具：用 SDK 的 `projectToolUpdates(messages, tools, undefined, toolHistory)` 取当前完整声明，全部包进一个 `{"type":"namespace","name":"dsh",...}`（LIMITS 要求）。
- 参数：
  - `temperature`、`stop` → `LlmError('UNSUPPORTED_PARAMETER')`，**不静默丢弃**（会改变输出）；
  - `maxTokens` → **不发送**（官方禁用 `max_output_tokens`），并记录一次 debug 日志。理由：DSH 自身的会话标题和 compaction 总是传 `maxTokens`（compaction 默认 8192）；它只是上限，不发送不会改变正确输出，而报错会让 compaction 在本 provider 上完全不可用。此行为写入 README；
  - `reasoningEffort` → 模型不声明推理档位，因此 DSH 在调用前就会拒绝任何显式档位（不发送 `reasoning`）。
- 流的格式：实测线上 `/v1/responses` 返回 SSE 但**没有 `Content-Type`**，所以只拒绝显式声明为非 SSE 的类型，其余交给 SSE 解析器和"必须读到 `response.completed`"的规则来把关。请求 ID 从 `x-oai-request-id` / `openai-request-id` / `x-request-id` 中读取（`requestIdOf`）。
- 流：只有 `response.completed` 才产出 `finish{stop|tool-calls}`；`response.incomplete` → `finish{max-tokens}`（原因为 `max_output_tokens` 时），否则为错误；`response.failed` / 流在终止事件前断开 → 错误。

### D5 模型目录：只用 `/v1/models` 的结果

- `models[]` 中 `visibility == "list"` 的条目，保留服务端顺序，`slug` → id，`display_name` → name；每个账号缓存，登录/登出/记录变更时失效。
- 能力：官方未提供能力字段 → `inputModalities: ['text']`；上下文窗口取保守默认值（可按模型在配置中覆盖）；不声明推理档位。不硬编码任何模型 ID。

### D6 错误映射

按 `openai-siwc-protocol.md` §12 的表格。原则：保留 HTTP 状态、`error.code`、`x-request-id`；面向用户的消息**只包含 code、状态、请求 ID 和官方给出的建议**，不回显响应体全文（`detail` 文本经脱敏和截断后附加）。重试策略：adapter 内部不重试；`providerRetryPolicy` 使用 DSH 的默认值，但不可重试的 SIWC code 使用不在默认可重试集合中的 code。

### D7 刷新

- 每次请求前，若 `expiresAt - 60s <= now`（且已过 `earliestRefreshAt`），就在 `modifyRecord` 的独占区间内刷新：先重读记录，若其他进程已刷新则直接使用。
- 刷新的终止错误（§7 列表）→ 删除 session 记录，抛出 `AUTH` 并提示重新登录；网络/5xx → 保留凭证，抛出可重试错误。

### D8 登出与卸载

- `/siwc logout`：停止使用 → 撤销 refresh token（5xx/网络错误有限重试）→ 删除 session 记录；未确认撤销时明确告知用户，并指引到 ChatGPT 设置中断开该 app。registry 记录保留。
- 在 DSH 设置中直接删除记录 = **只做本地删除**，不会远程撤销（README 说明）。
- 卸载插件不会删除凭证记录（DSH 设计如此），README 给出"先 `/siwc logout` 再卸载"的步骤，以及如何在设置中删除残留记录。

### D8a 授权范围

插件只在 `chatgpt.tokens.use.direct` 已授予时才发起推理；缺少该 scope 时保留登录，`/siwc status` 显示"plan usage 未启用"，请求抛 `SIWC_PLAN_USAGE_DISABLED`。重新同意（`prompt=consent`）放在 P1。

### D9 多账号：P0 不做

官方允许多账号，但 DSH 一条 flow 对应一个记录 key，多账号需要动态 flow 注册和账号选择 UI。P0 只做单个活动账号；registry 已按多账号设计，便于 P1 扩展。

## 后果

- 正面：零核心耦合；复用 DSH 的凭证 UI、授权 UI、重试与取消机制；协议细节集中在少数几个模块中。
- 负面：令牌在 `0600` 文件而非钥匙串；能力信息不足导致图片/推理档位在 P0 不可用；`maxTokens` 被忽略。
- 待真实环境验证的事项见协议文档 §15。

## 修订（真实环境验证后）

- **D4/D5 修订：能力来自账号目录。** 实测发现 `/v1/models` 包含 `input_modalities`、`context_window` 和 `supported_reasoning_levels`（文档未列出）。插件据此声明输入模态、上下文窗口和推理档位，可选档位 = 目录级别 ∩ API 文档允许的值（实测 API 拒绝目录中的 `ultra`）。不设置默认档位（实测服务端默认值与目录的 `default_reasoning_level` 不一致）。
- **图片**：目录声明 `image` 的模型，用户消息和工具结果中的图片通过 `ctx.attachments.readImageRequest` 生成路由版本，以 data URL 内联发送，并附上 DSH 的标准描述文本。图片总量按 `maxRequestImageBytes`（默认 20 MiB，保守值）计算，超出时抛出 `IMAGE_OFFLOAD_REQUIRED`，交给 DSH 卸载最早的图片。附件服务通过 `ctx.get('attachments')` 可选获取：没有挂载附件服务的组合仍能加载插件，只是遇到图片时会明确报错。
- **错误传播**：`resolveModel` 只在**未登录**时回退为保守信息（纯文本、无档位）；刷新失败、网络错误等都作为该次请求的错误抛出，不会被静默降级。
