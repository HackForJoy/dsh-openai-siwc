# OpenAI SIWC（ChatGPT plan usage for open-source）协议核实

> 本文是对官方文档在核实当时的快照。官方文档更新后，以官方文档为准。

> 核实日期：2026-10-28。唯一依据：developers.openai.com 官方文档（各页 `.md` 原文）与 `https://auth.openai.com/.well-known/openid-configuration`。
> 标记说明：✅ = 官方文档明确；⚠️ = 官方文档未明确，**待验证**，实现中不假设。

## 0. 来源

| 简称 | URL |
|---|---|
| OVERVIEW | https://developers.openai.com/siwc/token-sharing-open-source |
| SIGNIN | https://developers.openai.com/siwc/token-sharing-open-source/sign-in |
| SESSIONS | https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions |
| MODELS | https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference |
| TOKENS | https://developers.openai.com/siwc/token-sharing-open-source/token-reference |
| ERRORS | https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery |
| LIMITS | https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations |
| UIUX | https://developers.openai.com/siwc/ui-ux-guidelines |
| QUICKSTART | https://developers.openai.com/siwc/quickstart |
| OIDC | https://auth.openai.com/.well-known/openid-configuration |
| FC | https://developers.openai.com/api/docs/guides/function-calling （namespace 工具） |
| CREATE | https://developers.openai.com/api/reference/resources/responses/methods/create |

## 1. 适用范围与资格

- ✅ 面向**开源及本地托管**应用；付费或远程托管应用需走 interest form（OVERVIEW）。
- ✅ "ChatGPT plan usage is available to all open-source partners and selected private clients."（QUICKSTART）
- ✅ 用户侧：**合格的 ChatGPT Plus 与 Pro 用户**（QUICKSTART）。其他套餐（Free/Team/Enterprise/Edu）未列出 → 不假设支持。
- ✅ 不授予访问用户 ChatGPT 对话或 API key 的权限（OVERVIEW、QUICKSTART）。
- ✅ Plus 用户的 5 小时用量上限在所有使用 ChatGPT plan 的 app 间共享；Pro 无此 5 小时上限（SESSIONS）。
- ✅ 服务端资格不满足时返回 `subscription_sharing_user_not_eligible`（ERRORS）——插件只上报，不重试、不循环 OAuth。

## 2. 客户端与宿主标识

- ✅ `client_id=dynamic_agent_client`：**仅**首次注册的入口，**不得保存、不得用于换 token**（SIGNIN）。
- ✅ 回调返回**颁发的** `client_id`（形如 `oaiapp_...`），按 ChatGPT 账号保存并在后续登录复用（SIGNIN）。
- ✅ 每个 `client_id` 绑定"认证用户 + 注册时选择的 workspace"（OVERVIEW）。
- ✅ `ext_agent_host_id`：**必填**，每个宿主不同；首次登录前生成并持久化；同一宿主始终发送同一值；不透明、不得包含 email/用户 ID；**不是凭证**（OVERVIEW、SIGNIN）。
  - 首选：RFC 9278 JWK thumbprint URI `urn:ietf:params:oauth:jwk-thumbprint:…`（可选）。
  - 支持：`urn:uuid:<UUIDv4>`。**本插件采用此格式**（`crypto.randomUUID()`）。
  - 接受：`did:key:…`。
- ✅ `agent_name_hint`：应用的真实名称，各安装一致；**仅首次注册**发送，重授权时省略；用户可在批准前修改；只是展示元数据（SIGNIN）。

## 3. 授权请求

- ✅ 端点：`GET https://auth.openai.com/api/accounts/authorize`，在**系统浏览器**中打开，每个查询参数值 URL 编码（SIGNIN；与 OIDC `authorization_endpoint` 一致）。
- ✅ 每次尝试生成新的 `state`、`nonce`、PKCE verifier，并保留到回调完成（SIGNIN）。

| 参数 | 值 |
|---|---|
| `client_id` | 首次 `dynamic_agent_client`；之后用颁发的 ID |
| `agent_name_hint` | 仅首次注册 |
| `ext_agent_host_id` | 必填 |
| `id_token_hint` | 重授权可选；上次成功登录的 ID token（可过期）；**登出后省略** |
| `login_hint` | 重授权可选；已验证 ID token 中的 email |
| `response_type` | `code` |
| `redirect_uri` | `http://127.0.0.1:<port>/auth/callback`；仅端口可变；**不得**换成 `localhost`；授权与换码必须完全一致；**先启动监听再开浏览器** |
| `scope` | `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct` |
| `resource` | `https://api.openai.com/v1` |
| `state` / `nonce` | 新随机值 |
| `code_challenge_method` | `S256`（OIDC 仅支持 S256） |
| `code_challenge` | base64url(SHA-256(verifier))，无填充 |

- ✅ 重新同意：仅当用户主动选择启用 plan usage（例如先前拒绝过）时，用完整 scope 集 + `prompt=consent` 重走 OAuth；`force_reconsent=true` 仅在 OpenAI 确认对该集成上线后使用；**普通登录不得强制同意**（ERRORS）。

## 4. 回调与换码

- ✅ `error=access_denied`：先校验 `state`，停止，不换码（SIGNIN）。
- ✅ 先校验 `state` 并处理任何 OAuth `error`，再使用结果（SIGNIN）。
- ✅ 新注册成功回调：`code`、`state`、颁发的 `client_id`，可能有 `scope`。**缺少颁发 ID → 注册未完成**（SIGNIN）。
- ✅ 重授权回调可能省略 `client_id`；若提供了**不同**的 `client_id` → 拒绝结果（SIGNIN）。
- ✅ 换码：`POST https://auth.openai.com/api/accounts/oauth/token`，`application/x-www-form-urlencoded`：`grant_type=authorization_code`、颁发的 `client_id`、`code`、`code_verifier`、相同 `redirect_uri`、相同 `resource`。**无 client secret**（SIGNIN；OIDC `token_endpoint_auth_methods_supported` 含 `none`）。
- ✅ 换码返回 `invalid_grant` → 丢弃该 code，用保留的颁发 ID 重新授权（SIGNIN）。
- ✅ 令牌响应字段：`access_token`、`refresh_token`（仅当授予 `offline_access`）、`id_token`、`token_type`、`expires_in`、`scope`、`earliest_refresh_at`（TOKENS）。
- ⚠️ `earliest_refresh_at` 的语义与格式（Unix 秒？ISO？）未定义。**实现：解析为可选值；若存在且为数字/日期，主动刷新不早于该时间；不依赖其存在。**

## 5. ID Token 校验

- ✅ 用 OpenAI 发布的 JWKS 验签；检查 issuer、audience = 颁发的 client ID、过期时间、本次保存的 nonce（SIGNIN）。
- ✅ OIDC：`issuer = https://auth.openai.com`，`jwks_uri = https://auth.openai.com/.well-known/jwks.json`，签名算法 `RS256`（OIDC）。
- ✅ 用验证后的 `sub` 作为账号身份；email 和 `sub` 都不是 workspace 标识，必须与颁发的 client ID 一起保存（SIGNIN）。
- ✅ 回访账号：替换凭证前确认新 ID token 的身份与所选账号一致（SIGNIN）。
- ✅ **权限检查**：推理前确认令牌响应授予的 scope 含 `chatgpt.tokens.use.direct`；"A valid ID token alone does not authorize ChatGPT plan usage."（SIGNIN）。若缺失但 ID token 有效 → 保留登录、标记 plan usage 为禁用（ERRORS）。
- 实现：使用成熟库 `jose`（`createRemoteJWKSet` + `jwtVerify`，限定 `algorithms: ['RS256']`），不自行实现密码学。

## 6. 凭证存储

- ✅ 每个"颁发 client ID + 已验证账号身份"一条独立受保护记录；保存身份、tokens、授予的 scopes、过期信息；保留 ID token 用于 `id_token_hint`；host ID 与其运行时一起保存（SIGNIN）。
- ✅ 文件存储：应用自定义路径，**原子写入，`0600`**，不得提交或记录（SIGNIN）。
- ✅ 刷新成功后**一起**替换 access token、过期时间、授予 scopes、轮换的 refresh token（SIGNIN）。
- ✅ token 不得出现在浏览器存储、源码管理、日志、分析、支持记录中；**不得放入 URL**；含 `id_token_hint` 的授权 URL 必须在日志/诊断中脱敏（SESSIONS）。

## 7. 刷新

- ✅ `POST https://auth.openai.com/api/accounts/oauth/token`，form：`grant_type=refresh_token`、颁发的 `client_id`（非 `dynamic_agent_client`）、`refresh_token`、`resource=https://api.openai.com/v1`；**省略 `scope`** 以保留授权（SESSIONS）。
- ✅ access token 1 小时；refresh token 30 天，每次刷新轮换并重置 30 天（TOKENS）。
- ✅ **同一会话的刷新必须串行化**，避免两个进程竞争轮换 token（SESSIONS）→ 用 DSH `ctx.credentials.modifyRecord` 的跨进程独占区间实现。
- ✅ 不可用的 refresh token：`invalid_grant`、`invalid_refresh_token`、`token_expired`、`refresh_token_expired`、`refresh_token_invalidated`、`refresh_token_reused` → 清除不可用 token，用保存的颁发 client ID 重新 OAuth（ERRORS）。
- ✅ `invalid_client` → 修复客户端配置（ERRORS）。
- ✅ 临时网络/基础设施故障**不得**删除凭证（ERRORS）。

## 8. 登出与撤销

- ✅ `revocation_endpoint`：从 OIDC 文档读取（当前为 `https://auth.openai.com/api/accounts/oauth/revoke`）（SESSIONS、OIDC）。
- ✅ form `POST`：`token=<REFRESH_TOKEN>`、`token_type_hint=refresh_token`、颁发的 `client_id`。空 `200` = 成功（含已失效 token）（SESSIONS）。
- ✅ 网络失败或 `5xx`：在 refresh token 仍可用时带退避重试；若最终未确认撤销就本地清除，必须告知用户"远程撤销未确认"，可在 ChatGPT 设置中断开该 app（SESSIONS）。
- ✅ 登出：停止请求 → 尝试撤销 → 清除该账号的 access/refresh/ID token → **保留**账号/client 映射和本机 host ID 以便下次登录（SESSIONS）。撤销会话不删除注册的 client。
- ✅ OpenAI 不会在用户于 ChatGPT 设置中断开 app 时通知客户端；由请求或刷新确认断开后再要求重新登录（ERRORS）。

## 9. 模型发现

- ✅ `GET https://api.openai.com/v1/models`，`Authorization: Bearer <ACCESS_TOKEN>`（与推理同一 token）（MODELS）。
- ✅ 响应含 `models` 数组；只保留 `visibility == "list"` 的条目；读取 `slug`（作为请求的 `model`）和 `display_name`（展示）；**保留服务端顺序**；切换账号后刷新（MODELS）。
- ✅ 注意：这与普通 API Key 的 `/v1/models`（`data` 数组、`id` 字段）**形状不同**，不可混用。
- ⚠️ 模型条目中是否有上下文窗口、输入模态、推理档位、工具支持等能力字段**未文档化**。实现：
  - 不硬编码任何模型 ID；
  - 输入模态声明为 `['text']`（DSH 推荐的"少声明"立场；图片作为 P1，需要能力来源）；
  - 上下文窗口：文档未给出 → 使用保守默认值，并允许用户在配置中按模型覆盖；
  - 推理档位：不声明（服务端默认）。
- ✅ "a successfully completed inference turn verifies access to the selected model"（Codex app-server 页）→ 列表是目录，不是授权凭据。

## 10. 推理（Responses API）

- ✅ `POST https://api.openai.com/v1/responses`，`Authorization: Bearer <ACCESS_TOKEN>`，`Content-Type: application/json`（MODELS）。
- ✅ **不得**指向 ChatGPT `backend-api`（MODELS）。
- ✅ 每个 HTTP 请求：`store: false`、`stream: true`（MODELS、LIMITS）。
- ✅ `input` 为数组，每次带上完整所需上下文；**不得**使用 `previous_response_id`（LIMITS）。
- ✅ 系统提示用 `instructions` 或 developer 消息；`{type:"message", role:"system"}` **被拒绝**（LIMITS）。
- ✅ 必须省略：`background`、`conversation`、`max_output_tokens`、`max_tool_calls`、`metadata`、`moderation`、`multi_agent`、`prompt`、`prompt_cache_retention`、`safety_identifier`、`temperature`、`top_logprobs`、`top_p`、`truncation`、`user`（LIMITS）。
  - 推论：DSH 的 `temperature`、`maxTokens` 无法映射 → **显式报错**（不静默丢弃）。`stop` 字段 Responses API 本身不提供 → 同样显式报错。
- ✅ 工具：函数/自定义工具必须**放在 namespace 中**，或通过 `additional_tools` 输入项提供（LIMITS）。namespace 格式（FC、CREATE）：
  ```json
  { "type": "namespace", "name": "crm", "description": "...",
    "tools": [ { "type": "function", "name": "...", "description": "...", "parameters": { } } ] }
  ```
  返回的 `function_call` 项与回传的 `function_call` / `function_call_output` 输入项均带可选 `namespace` 字段（CREATE）。
- ✅ 不支持的工具：图像生成、file search、Code Interpreter、computer use、托管 MCP/connectors、`tool_search`；`programmatic_tool_calling` 不得放在顶层 `tools`（LIMITS）。
- ✅ 输入：文本、图片、文件在**所选模型接受时**可用；音频/视频、Files 上传 API、转写 API 不支持（LIMITS）。
- ⚠️ `reasoning`（effort）、`include`（如 `reasoning.encrypted_content`）、`tool_choice`、`parallel_tool_calls` 不在禁用列表，但也未被 SIWC 文档确认。**P0 不发送**；P1 需真实环境验证后再加。
- ✅ OpenAI Python SDK 示例使用 `max_retries=0`（MODELS）→ adapter 内部不重试，交给 DSH 重试策略且须对 SIWC 特定错误码设为不可重试。

## 11. 流式事件

- ✅ 文档明确的事件：`response.output_text.delta`、`response.completed`（唯一成功终止）、`response.failed`（`response.error.code`）、`response.incomplete`（MODELS）。
- ✅ **只有收到 `response.completed` 才算成功**；必须读到终止事件；`response.incomplete`、显式错误、中断的流须与成功区分（MODELS）。
- ✅ 用量上限错误可在流开始后以 `response.failed` 到达：`subscription_sharing_usage_limit_exceeded`、`subscription_sharing_usage_unavailable`（MODELS）。
- 工具调用相关事件（`response.output_item.added`、`response.function_call_arguments.delta`、`response.output_item.done`）属于标准 Responses 流式协议（CREATE），SIWC 文档未单独说明 → 实现按标准协议解析，⚠️ 需真实环境验证。

## 12. 错误与恢复

**准入阶段（流开始前）**，响应体可能是 `{"detail":"..."}`，只作诊断文本（ERRORS）：

| 状态 | 处理 |
|---|---|
| 401 | 身份或直连权限未被接受；检查所选账号和授予 scope |
| 403 | 策略/权限（如服务区域）阻止；上报限制 |
| 503 | 直连不可用或未开启；保留凭证，有限退避 |

**结构化 Responses 错误**（按 `error.code` + `error.param`；非穷举）：

| code | 状态 | 处理 | DSH code / 可重试 |
|---|---|---|---|
| `subscription_sharing_user_not_eligible` | 403 | 说明限制，不重试、不循环 OAuth | `SIWC_NOT_ELIGIBLE` / 否 |
| `subscription_sharing_usage_limit_exceeded` | 429 | 暂停，链接 https://chatgpt.com/settings/usage；不推断重置时间 | `QUOTA` / 否 |
| `subscription_sharing_usage_unavailable` | 503 | 保留凭证，稍后有限退避 | `SIWC_USAGE_UNAVAILABLE` / 是 |
| `subscription_sharing_unsupported_capability` | 400 | 依 `error.param` 去掉不支持的输入；不重试同一请求体 | `SIWC_UNSUPPORTED_CAPABILITY` / 否 |
| `subscription_sharing_route_not_supported` | 403 | 校验方法与端点 | `SIWC_ROUTE_NOT_SUPPORTED` / 否 |
| `subscription_sharing_invalid_user` | 401 | 记录 request ID；仅在确认撤销或刷新终止错误后要求重新登录 | `AUTH` / 否 |
| `chatpass_v2_scope_not_authorized`、`chatpass_v2_invalid_authorization_context` | 403 | 检查客户端与授权配置；不重试、不换计费 | `SIWC_SCOPE_NOT_AUTHORIZED` / 否 |
| `subscription_sharing_user_unavailable` | 503 | 保留凭证，有限退避 | `SIWC_USER_UNAVAILABLE` / 是 |

- ✅ "OpenAI does not silently switch the request to another billing path. Preserve the actual HTTP status, response body shape, error code when present, and request ID."（ERRORS）
- ⚠️ 文档未覆盖：通用 429/5xx、模型不允许等 → 按 HTTP 状态做通用映射（429 → `RATE_LIMIT`，5xx → 可重试的 `SERVER`），并保留原始 code。

## 13. UI/品牌要求

- ✅ 登录动作标签：**Continue with ChatGPT**（SIGNIN、UIUX）。
- ✅ 首次启用 plan usage 时显示一次性说明（eligible 请求会使用 ChatGPT plan，可在 ChatGPT 设置中管理）（UIUX）。
- ✅ 在用量相关处链接 https://chatgpt.com/settings/usage（SESSIONS）。
- 受 DSH `AuthorizationFlow` 词汇限制（label + methods + notice），插件能控制的只有 flow/method 的 label 与 notice 文本；按钮视觉样式由 DSH 设置 UI 决定。⚠️ 无法在插件内提供官方品牌按钮图形。

## 14. 与其他机制的区别（防混淆）

| | SIWC（本插件） | 传统 Codex OAuth（DSH `openai-codex`） | OpenAI API Key |
|---|---|---|---|
| client_id | 动态注册颁发 `oaiapp_...` | Codex CLI 固定 client | 无 |
| 计费 | 用户 ChatGPT plan | ChatGPT plan（Codex） | API 账户 |
| 推理端点 | `api.openai.com/v1/responses` | ChatGPT backend | `api.openai.com/v1/*` |
| 必要 scope | `chatgpt.tokens.use.direct` 等 | 不同 | 无 |
| 模型列表 | `/v1/models` → `models[].slug` | — | `/v1/models` → `data[].id` |

本插件不读取、不复用其他工具（Codex CLI、DSH `openai-codex`）的凭证，也不把 SIWC token 当作 API Key 交给其他 provider。

## 15. 待验证清单（需真实账号）

1. `/v1/models` 条目的完整字段（能力信息是否存在）。
2. `earliest_refresh_at` 的格式与语义。
3. 流中工具调用事件在此路由上的实际形态（namespace 字段是否回传）。
4. `reasoning.effort`、`include`、`tool_choice`、`parallel_tool_calls` 是否被接受。
5. 图片输入（`input_image` data URL）在哪些模型上可用。
6. `usage` 字段在 `response.completed` 中是否存在及其结构。
7. 准入阶段 401/403/503 的实际响应体。

## 16. 真实环境观察（2026-10，DSH 0.2.1-rc.3）

以下事实来自在隔离的 DSH 实例中用真实账号做的验证，官方文档没有写明。每条都已体现在实现中。

### 16.1 登录与会话

| 观察 | 对实现的影响 |
|---|---|
| 浏览器授权、回环回调、新注册返回颁发的 `client_id`（`oaiapp_…`）都与文档一致 | — |
| **不符合资格的账号**（ChatGPT Free）在**换码阶段**收到 HTTP 400 `invalid_grant`，且不带 `error_description`；同一账号具备资格后，用同一个已颁发的 client 换码即可成功。文档中列出的资格错误只有推理阶段的 `subscription_sharing_user_not_eligible` 和授权阶段的 `access_denied` | 换码失败时保留已颁发的 client ID（`pendingClientId`），下次复用而不是重新注册；错误信息附带服务端说明和请求 ID；README 中提示 `invalid_grant` 最常见的原因是账号资格 |
| 换码成功时授予全部 6 个 scope；ID token 验签和 claim 校验通过 | — |
| `earliest_refresh_at` 是过期前约 6 分钟的时间点（按 Unix 秒解析） | 主动刷新不早于该时间 |
| 刷新会同时轮换 access token 和 refresh token，并**返回新的 ID token** | 新 ID token 同样验签并比对 `sub` |
| 撤销端点返回 200；退出后再次登录会复用已注册的 client，不会新建注册 | — |

### 16.2 推理请求与流

| 观察 | 对实现的影响 |
|---|---|
| `/v1/responses` 的 SSE 响应**没有 `Content-Type` 响应头** | 只拒绝显式声明为非 SSE 的类型 |
| 请求 ID 头是 `x-oai-request-id` | `requestIdOf()` 依次读取 `x-oai-request-id` / `openai-request-id` / `x-request-id` |
| 流中有未在文档中列出的 `response.metadata` 事件，以及标准的 `response.content_part.*` 事件 | 按未知事件忽略 |
| DSH 全部工具包进 namespace 后被接受；`function_call` → `function_call_output` 往返正常 | — |
| 日志和会话文件（含解压后的会话日志）中扫描不到 token | — |

### 16.3 模型目录与能力

`/v1/models` 的条目除 `slug`/`display_name`/`visibility` 外，还有约 50 个字段，其中本插件使用的是 `description`、`input_modalities`、`context_window`、`supported_reasoning_levels[{effort, description}]`。观察到的可见模型都是 `input_modalities: ["text","image"]`，`context_window` 为 272000 或 500000。

**推理强度**：

| 请求 | 结果 |
|---|---|
| `reasoning.effort: "high"` | 200，响应中回显 `reasoning.effort == "high"` |
| `"ultra"`（目录中有，API 文档中没有） | 400 `invalid_value`：允许值为 none, minimal, low, medium, high, xhigh, max |
| `"none"`（API 文档中有，但不在该模型的目录中） | 400 `unsupported_value` |
| 不发送 effort | 服务端默认值与目录中的 `default_reasoning_level` **不一致** |

→ 每个模型可选的 effort = 目录列出的级别 ∩ API 文档允许的值；不设默认档位，不传时使用服务端自己的默认值。在 DSH 中，选择器显示 Default/Low/Medium/High/Xhigh/Max，选中的档位会作为 `reasoning.effort` 发送。

**图片输入**：以 `input_image` + `data:` URL + `detail: "auto"` 发送时，模型能正确识别图片内容（在 DSH 中附加一张双色测试图，模型正确回答了两种颜色以及各自的位置）。

→ 只对目录声明 `image` 的模型发送图片；使用 DSH 附件服务生成的路由尺寸版本，以内联方式发送（此路由不支持 Files API）。单个请求的 base64 图片总量默认上限 20 MiB，超出时返回 `IMAGE_OFFLOAD_REQUIRED`。这个上限是保守值，服务端的实际上限未公布，也未实测触发。
