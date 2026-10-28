# 安全设计与威胁分析

范围：`dsh-openai-siwc` 0.1.0，运行在 DeepSeek Harness 0.2.1-rc.3 宿主进程内。

## 1. 资产

| 资产 | 存放位置 | 敏感度 |
|---|---|---|
| access token（1 小时） | `~/.dsh/.credentials.yaml` → `openai-siwc/session` | 高：可直接消耗用户的 ChatGPT plan 用量 |
| refresh token（30 天，会轮换） | 同上 | 最高：可持续获得新的 access token |
| ID token | 同上 | 中：含 email/sub；只用于身份确认 |
| 授权码、PKCE verifier、state、nonce | 只在内存中，单次尝试有效 | 高（短时） |
| 颁发的 client_id、host id | `openai-siwc/registry` | 低：不是凭证（官方明确 host id 不是凭证） |

## 2. 信任边界

1. **插件 ↔ DSH 宿主**：同一 Node 进程，无沙箱。插件信任 DSH 的 `ctx.credentials` / `ctx.authorization` / `ctx.llm`；DSH 本身也能读取一切。
2. **插件 ↔ 浏览器**：授权 URL 交给 DSH UI 打开；回调通过 `127.0.0.1` 回环端口返回。
3. **插件 ↔ OpenAI**：仅限 `auth.openai.com` 与 `api.openai.com`（固定 HTTPS 端点，不可配置）。
4. **插件 ↔ 本机其他进程**：可以访问回环端口；可以读取用户本人可读的文件。

## 3. 威胁与对策

| # | 威胁 | 对策 | 验证 |
|---|---|---|---|
| T1 | OAuth CSRF / 伪造回调注入攻击者的授权码 | 每次尝试生成 256 bit 随机 `state`，常量时间比较；不匹配返回 400 且**继续等待**真实回调 | `oauth.test.ts` 回调监听器用例 |
| T2 | 授权码截获 / 重放 | PKCE S256（256 bit verifier）；授权码单次使用（服务端）；监听器在首个有效回调后立即关闭 | mock 服务端校验 verifier；单元测试确认关闭后无法连接 |
| T3 | 回调劫持（其他进程/页面） | 只绑定 `127.0.0.1`，不用 `localhost`；只接受 `GET /auth/callback`；校验 `Host` 头（防 DNS rebinding）；OS 随机端口 | 单元测试：错误路径 404、错误方法 405、伪造 Host 400 |
| T4 | 开放重定向 | 回调页是静态 HTML，不重定向、不回显任何参数；`no-store`、`no-referrer`、`nosniff` | 单元测试检查响应头和响应体 |
| T5 | ID token 伪造或混用 | `jose` 校验 RS256 签名（官方 JWKS）、`iss`、`aud`=颁发的 client_id、`exp`、`nonce`；限定算法为 RS256；回访账号的 `sub` 必须与所选账号一致；刷新返回的 ID token 同样验签并比对 `sub` | `oauth.test.ts` ID token 用例；集成测试：伪造签名、账号不一致 |
| T6 | 注册不完整或 client_id 被替换 | 首次注册缺少颁发 ID → 拒绝；重授权回调带回不同 client_id → 拒绝；永不保存 `dynamic_agent_client` | 单元测试 + 集成测试 |
| T7 | 无 plan 权限时仍发起推理 | 推理前必须有 `chatgpt.tokens.use.direct`，刷新后再检查一次 | 集成测试：缺少该 scope 时未发出任何 `/responses` 请求 |
| T8 | 令牌经日志、错误、诊断泄露 | 日志只记录错误 code；所有外部文本经 `redact()`（JWT、Bearer、`*_token=`、JSON token 字段）并截断；`/siwc status` 不输出 token，client_id 截短；notice 中没有秘密 | `redact` 单元测试；集成测试检查 notice/status 输出 |
| T9 | 令牌出现在 URL 中 | token 只放在 `Authorization` 头；**不发送 `id_token_hint`**（它会让 ID token 出现在 UI 展示的 URL 中） | URL 构造单元测试 |
| T10 | 跟随重定向时带上 Bearer | 所有 `fetch` 都设 `redirect: 'error'` | 代码审查 |
| T11 | 配置被篡改，把 token 发往第三方 | 端点硬编码在 `OFFICIAL_ENDPOINTS`；插件配置只有上下文窗口和超时 | 代码审查 |
| T12 | 刷新竞争导致轮换的 refresh token 失效 | 在 `ctx.credentials.modifyRecord` 的跨进程独占区间内刷新；进入区间后先重读，若别的进程已刷新就直接使用 | 集成测试：3 个并发请求只发生 1 次刷新 |
| T13 | 临时故障误删凭证 | 只在官方列出的终止错误时删除 session；网络/5xx/429/非 JSON 的 200 都保留凭证 | 集成测试 |
| T14 | 登出后 token 在服务端仍有效 | `/siwc logout` 先撤销 refresh token（5xx/网络错误时重试），再删除本地记录；未确认撤销时明确告知用户 | 集成测试 |
| T15 | 切换账号后旧账号的 token 仍有效 | 提交新账号 session 前，尽力撤销旧账号的 refresh token | 代码审查 |
| T16 | 凭证文件被其他用户读取 | DSH 本地存储使用 `0600` + 原子写入 | 集成测试检查文件权限 |
| T17 | 凭证进入版本控制或测试夹具 | `.gitignore` 排除凭证/`.env`/HAR；测试只用 mock 生成的随机 token；`DSH_HOME` 在测试中指向临时目录 | 测试 setup |
| T18 | 供应链 | 运行时依赖只有 `jose`、`eventsource-parser`（均为 MIT，锁定精确版本，且发布已超过两周）；DSH SDK 作为 peer 依赖，不打包；pnpm `--ignore-scripts` | `pnpm-lock.yaml`、`pnpm licenses list` |
| T19 | 绕过服务端控制 | 不访问 ChatGPT `backend-api`，不复用浏览器 Cookie，不读取其他工具的凭证，不伪造客户端身份；SIWC 错误照原样上报，不切换计费路径或 provider | 代码审查；集成测试 |

## 4. 已知残余风险

1. **令牌不在 OS 钥匙串中**：任何以用户身份运行的进程都能读取 `~/.dsh/.credentials.yaml`。这是 ADR D3 的取舍：与 DSH 凭证体系保持一致（跨进程刷新互斥、设置界面可管理），也符合官方"`0600` 文件"的要求。缓解：泄露后在 ChatGPT 设置中断开该 app。
2. **插件与 DSH 同进程**：其他 DSH 插件理论上可以调用 `ctx.credentials.readRecord('openai-siwc/session')`。DSH 的凭证 seam 不做按插件的访问控制。
3. **授权 URL 展示在 DSH UI 中**：其中含有 `state`、`nonce` 和 PKCE challenge（不含 verifier）。拿到 URL 的人无法获得 verifier，所以无法完成换码。
4. **在 DSH 设置中直接删除记录**只会本地删除，不会远程撤销。README 中已说明。
5. **卸载不删除凭证**：DSH 设计如此。README 给出了"先登出再卸载"的步骤。
6. 回调监听器在授权期间（最长 10 分钟）对本机进程可见，但没有 state 无法利用。
