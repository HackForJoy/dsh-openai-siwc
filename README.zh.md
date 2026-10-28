# dsh-openai-siwc

[English](README.md) | 中文

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）提供的 LLM provider 插件。它通过 OpenAI 官方的 **Sign in with ChatGPT —— 面向开源客户端的 ChatGPT plan usage** 机制（SIWC），让 DSH 使用你的 ChatGPT 账号和套餐额度调用模型。

> 这是社区插件，**与 OpenAI、DeepSeek 均无隶属或背书关系**。
> 协议实现只以官方文档为依据：<https://developers.openai.com/siwc/token-sharing-open-source/sign-in>（详见 [`docs/research/openai-siwc-protocol.md`](docs/research/openai-siwc-protocol.md)）。

它**不是**下面这两样东西：

- 不是传统的 Codex OAuth（DSH 内置的 `openai-codex` provider 用的是那种）；
- 不是 OpenAI API Key provider。它不会把 SIWC token 当作 API key，也不会在失败时切换到其他计费方式。

## 使用条件

- OpenAI 官方说明：ChatGPT plan usage 面向**合格的 ChatGPT Plus / Pro 用户**，适用于开源、本地运行的应用。不符合资格的账号（例如 ChatGPT Free）在登录的换码阶段就会被拒绝（`invalid_grant`）。
- 兼容性：已在 **DSH 0.2.1-rc.3**（`@deepseek-ai/cordis ~4.0.5`）上验证；Node.js ≥ 22。DSH SDK 仍是预发布版本，各版本之间存在不兼容变更，因此 peer 依赖固定在精确版本上，DSH 每次升级后都会发布对应的插件版本。
- Plus 用户的 5 小时用量上限在所有使用 ChatGPT plan 的应用间共享。用量与授权管理：<https://chatgpt.com/settings/usage>。

## 安装

使用 DSH 自带的 CLI 安装到某个 profile（会自动写入该 profile 的 `dependencies` 和 `dsh.profile.bundles`）：

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"   # macOS
"$DSH" plugin --profile <profile> add @hackforjoy/dsh-openai-siwc
```

然后启动该 profile（例如 `"$DSH" <profile>`）。插件随包提供的 `cordis.patch.yml` 会以 id `openai-siwc` 挂载插件。

- 建议先装进一个独立的测试 profile，甚至独立的 `DSH_HOME`（例如 `DSH_HOME=~/.dsh-siwc-test`），不要直接改日常使用的 profile。
- pnpm 会提示缺少 `@deepseek-ai/*` peer 依赖，这是正常的：这些包由 DSH 宿主提供（DSH 官方的第三方插件 `dsh-subagent-codex` 也是这样）。
- **升级**：执行 `"$DSH" plugin --profile <profile> add @hackforjoy/dsh-openai-siwc@<新版本>`，然后重启 DSH。

从源码安装请见下文"开发"一节。

## 配置（可选）

在 profile 的 `cordis.patch.yml` 中按 id 覆盖：

```yaml
- id: openai-siwc
  name: '@hackforjoy/dsh-openai-siwc'
  config:
    defaultContextWindow: 128000     # 仅用于目录中没有给出 context_window 的模型
    models:
      some-model-slug:
        contextWindow: 200000        # 按模型覆盖
    streamIdleTimeoutMs: 300000      # 流式响应允许的最长静默时间
    maxRequestImageBytes: 20971520   # 单个请求的 base64 图片上限，超出时由 DSH 卸载最早的图片
```

OpenAI 端点**不可配置**（防止 token 被发往其他地址）。

## 登录

DSH 0.2.1 的设置页面还没有给第三方授权流程提供入口，所以登录通过斜杠命令完成：

1. 在**会话中**执行 `/siwc login`（如需添加另一个 ChatGPT 账号，执行 `/siwc login new`）。DSH 首页的空白输入框不会显示命令输出，请在已有会话中执行。
2. 插件会打开**系统浏览器**（官方要求）。在浏览器中登录 ChatGPT，确认 agent 名称（"DSH OpenAI SIWC"），并**允许使用 ChatGPT plan**。
3. 浏览器回到 `http://127.0.0.1:<随机端口>/auth/callback`，显示 "Sign-in finished" 后即可关闭；命令会输出 "Signed in to ChatGPT as …"。

授权链接只交给浏览器，不会出现在命令输出或会话日志中。如果没有授予 plan usage 权限，插件会保留登录状态，但推理请求会报 `SIWC_PLAN_USAGE_DISABLED`。重新登录并允许即可。

## 使用

- 在模型选择器中选择 **ChatGPT plan (Sign in with ChatGPT)** 下的模型。模型列表来自你账号的 `GET /v1/models`（只显示 `visibility: "list"` 的模型），换账号后会刷新。
- 支持文本、流式输出、多轮对话、工具调用（工具被包进名为 `dsh` 的 namespace，这是官方要求）、图片输入和推理强度选择。模型能力（输入类型、上下文窗口、推理档位）都来自账号的模型目录，不做猜测。
- 斜杠命令（需要 DSH 加载 commands 服务）：
  - `/siwc login [new]`：登录（见上文）；
  - `/siwc status`：登录状态、plan usage 状态、授予的 scope、token 剩余时间、最近一次登录失败和模型列表错误（不显示任何 token）；
  - `/siwc models`：实时拉取当前账号的模型列表；
  - `/siwc logout`：登出（见下文）。

### 与其他 provider 的行为差异

| DSH 参数 | 行为 | 原因 |
|---|---|---|
| `temperature` | **报错** `UNSUPPORTED_PARAMETER` | 官方禁止该字段；静默丢弃会改变输出 |
| `stop` | **报错** `UNSUPPORTED_PARAMETER` | Responses API 没有 stop 序列 |
| `reasoningEffort` | 映射为 `reasoning.effort` | 可选档位来自账号模型目录，并与 API 允许的值取交集（例如目录中的 `ultra` 不被 API 接受，会被去掉）。选择 Default 时使用服务端自己的默认值 |
| `maxTokens` | **不发送**，记录一次日志 | 官方禁止 `max_output_tokens`。DSH 的 compaction 和会话标题总会带上它；它只是上限，忽略不影响正确性 |
| 图片输入 | 目录声明支持图片的模型：以内联 data URL 发送（含工具结果中的图片）；纯文本模型：用文本占位符代替 | 单个请求默认最多 20 MiB base64 图片（`maxRequestImageBytes`），超出时由 DSH 卸载最早的图片 |
| 推理内容回放 | 不回放 | `store:false`，且没有加密推理内容 |

## 登出

```
/siwc logout
```

依次执行：停止使用 token → 向 OpenAI 撤销 refresh token（失败时重试）→ 删除本地 token。已注册的 client_id 和本机 host id 会保留，下次登录时复用。如果撤销未能确认，插件会明确提示，此时可以在 ChatGPT 设置中手动断开该 app。

> 在 DSH 设置中直接删除 `openai-siwc/session` 记录**只做本地删除，不会远程撤销**。

## 卸载

1. 先执行 `/siwc logout`（撤销远程会话）；
2. 执行 `"$DSH" plugin --profile <profile> remove @hackforjoy/dsh-openai-siwc`，然后重启 DSH；
3. 卸载**不会**自动删除凭证记录（DSH 的设计）。如需彻底清理，请在 DSH 设置中删除 `openai-siwc/session` 和 `openai-siwc/registry`。删除 registry 后，下次登录会注册一个新的 client 和 host id。

## 凭证存储

凭证存放在 DSH 凭证存储中（默认 `~/.dsh/.credentials.yaml`，权限 `0600`，原子写入），包括两条记录：

- `openai-siwc/registry`：本机 host id（`urn:uuid:…`）以及已注册账号（client_id、sub、email）；
- `openai-siwc/session`：当前账号的 access/refresh/ID token、授予的 scope 和过期时间。

刷新在 DSH 的跨进程独占写入中执行，多个 DSH 进程不会争用同一个轮换的 refresh token。安全设计见 [`docs/security/threat-model.md`](docs/security/threat-model.md)；漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 常见问题

| 现象 / 错误码 | 原因与处理 |
|---|---|
| `MISSING_CREDENTIAL` | 未登录。执行 `/siwc login` |
| `SIWC_PLAN_USAGE_DISABLED` | 登录时没有授予 plan usage。执行 `/siwc login` 并允许 |
| 登录报 `invalid_grant` | 最常见的原因是账号不是 Plus/Pro（Free 账号会在换码这一步被拒绝）。升级后重新执行 `/siwc login`，插件会复用已保留的 client ID |
| "Could not open the system browser" | 插件无法启动系统浏览器（例如在无图形界面的环境中）；本插件只支持在本机运行 |
| 登录报 "declined in the browser" | 在浏览器中拒绝了授权。可以重新登录并允许，或改用其他 provider（例如你自己的 API key） |
| 登录报 "Registration incomplete" | 回调中没有颁发的 client_id。重新登录 |
| 登录报 "ID token failed validation" | ID token 未通过签名或 claim 校验，插件拒绝保存。检查系统时间后重试 |
| `QUOTA`（`subscription_sharing_usage_limit_exceeded`） | 达到 ChatGPT plan 的用量上限（可能是这个 app 单独的上限）。在 <https://chatgpt.com/settings/usage> 查看。插件不会自动重试 |
| `SIWC_NOT_ELIGIBLE` | 该用户、workspace 或策略不支持 plan usage。不会重试 |
| `SIWC_UNSUPPORTED_CAPABILITY` | 请求中包含不支持的输入、工具或模型；错误信息里的 `param=` 指出了具体是哪一项 |
| `AUTH`（401） | token 或权限未被接受。先执行 `/siwc status`；只有当会话确认已被撤销时才需要重新登录 |
| `SERVER`（503，如 `usage_unavailable`） | 临时故障，DSH 会按重试策略重试，凭证会保留 |
| `TRANSPORT`："stream ended before response.completed" | 连接中断，可以重试 |
| 模型列表为空 | 未登录，或拉取失败；`/siwc status` 会显示最近一次错误 |

所有错误消息都包含 HTTP 状态和 OpenAI 的 request id（如果有），但不包含任何 token。

## 开发

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck   # tsc --noEmit（含测试）
pnpm test        # vitest：单元测试 + 集成测试（真实的 DSH 服务 + 本地 mock OpenAI）
pnpm build       # 输出到 lib/
pnpm pack:verify # 打包并输出 SHA-256，用于校验构建产物
```

从源码安装到 DSH：`"$DSH" plugin --profile <profile> add "file:/绝对路径/hackforjoy-dsh-openai-siwc-<版本>.tgz"`。版本号不变时重新安装，需要先 `remove` 再 `add`。

集成测试会挂载真实的 `@deepseek-ai/dsh-llm`、`dsh-authorization`、`dsh-credentials-local`、`dsh-attachment-local`（全部写在临时目录），并对接 `tests/helpers/mock-openai.ts`。这个 mock 严格实现官方协议：校验 PKCE，强制 `redirect_uri`/`resource`/`client_id` 一致，refresh token 轮换并拒绝重用，拒绝禁用字段，并模拟线上实测到的行为（SSE 不带 `Content-Type`、`x-oai-request-id`）。测试会把 `DSH_HOME` 指向临时目录，绝不触碰真实的 `~/.dsh`。

npm 上的版本由 GitHub Actions 通过 npm Trusted Publishing 发布，并附带 provenance；用 `npm view @hackforjoy/dsh-openai-siwc --json` 或 npm 页面上的 provenance 信息即可核对每个版本对应的源码提交。

贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)，变更记录见 [CHANGELOG.md](CHANGELOG.md)。

## 验收状态与限制

- **真实环境验收（DSH 0.2.1-rc.3，具备资格的 ChatGPT 账号）**：登录、退出后再次登录、模型列表、流式文本、多轮对话、工具调用往返、令牌刷新与轮换、推理强度、图片输入、登出与远程撤销均已通过；日志与会话文件中没有 token。
- 尚未在真实环境验证：`/siwc login new` 添加第二个账号、`IMAGE_OFFLOAD_REQUIRED` 的真实触发（服务端的图片上限未公布）。
- 官方文档未明确、通过真实环境确认的事项见 [`docs/research/openai-siwc-protocol.md` §16](docs/research/openai-siwc-protocol.md)。
- 只支持单个活动账号（可以保存多个账号并在登录时选择）。
- 架构决策见 [`docs/adr/ADR-001-siwc-provider-plugin.md`](docs/adr/ADR-001-siwc-provider-plugin.md)。

## 许可证

MIT，见 [LICENSE](LICENSE)。
