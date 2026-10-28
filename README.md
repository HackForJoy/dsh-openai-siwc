# dsh-openai-siwc

English | [中文](README.zh.md)

An LLM provider plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH). It uses OpenAI's official **Sign in with ChatGPT — ChatGPT plan usage for open-source clients** (SIWC) so DSH can call models with your ChatGPT account and plan.

> This is a community plugin. It is **not affiliated with or endorsed by OpenAI or DeepSeek**.
> The protocol is implemented strictly from the official documentation: <https://developers.openai.com/siwc/token-sharing-open-source/sign-in> (see [`docs/research/openai-siwc-protocol.md`](docs/research/openai-siwc-protocol.md)).

It is **not**:

- traditional Codex OAuth (what DSH's built-in `openai-codex` provider uses);
- an OpenAI API key provider. It never treats a SIWC token as an API key and never falls back to another billing path when a request fails.

## Requirements

- Per OpenAI, ChatGPT plan usage is for **eligible ChatGPT Plus / Pro users** in open-source, locally run apps. An ineligible account (for example ChatGPT Free) is refused during sign-in, at the code exchange (`invalid_grant`).
- Compatibility: verified with **DSH 0.2.1-rc.3** (`@deepseek-ai/cordis ~4.0.5`); Node.js ≥ 22. The DSH SDK is still pre-release and changes incompatibly between versions, so peer dependencies are pinned exactly and a matching plugin release follows each DSH update.
- For Plus users, the five-hour usage limit is shared across every app that uses the ChatGPT plan. Manage usage and app access at <https://chatgpt.com/settings/usage>.

## Install

Install into a profile with the DSH CLI (it records the plugin in the profile's `dependencies` and `dsh.profile.bundles`):

```sh
DSH="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"   # macOS
"$DSH" plugin --profile <profile> add @hackforjoy/dsh-openai-siwc
```

Then start the profile (for example `"$DSH" <profile>`). The bundled `cordis.patch.yml` mounts the plugin under the id `openai-siwc`.

- Consider trying it in a separate profile, or even a separate `DSH_HOME` (e.g. `DSH_HOME=~/.dsh-siwc-test`), before adding it to the profile you use every day.
- pnpm warns about missing `@deepseek-ai/*` peer dependencies. That is expected: the DSH host provides them (DSH's own third-party plugin `dsh-subagent-codex` works the same way).
- **Upgrade**: `"$DSH" plugin --profile <profile> add @hackforjoy/dsh-openai-siwc@<new version>`, then restart DSH.

To install from source, see [Development](#development).

## Configuration (optional)

Override by id in the profile's `cordis.patch.yml`:

```yaml
- id: openai-siwc
  name: '@hackforjoy/dsh-openai-siwc'
  config:
    defaultContextWindow: 128000     # only for models whose catalog entry has no context_window
    models:
      some-model-slug:
        contextWindow: 200000        # per-model override
    streamIdleTimeoutMs: 300000      # longest silence tolerated on an open stream
    maxRequestImageBytes: 20971520   # base64 image budget per request; DSH offloads the oldest images beyond it
```

The OpenAI endpoints are **not configurable**, so a tampered configuration cannot send tokens elsewhere.

## Sign in

DSH 0.2.1's settings UI has no entry point for third-party authorization flows yet, so sign-in uses a slash command:

1. Run `/siwc login` **inside a conversation** (`/siwc login new` adds another ChatGPT account). The empty composer on the DSH home page does not display command output.
2. The plugin opens your **system browser** (as the official docs require). Sign in to ChatGPT, confirm the agent name ("DSH OpenAI SIWC"), and **allow ChatGPT plan usage**.
3. The browser returns to `http://127.0.0.1:<random port>/auth/callback` and shows "Sign-in finished"; the command prints "Signed in to ChatGPT as …".

The authorization URL goes only to the browser; it never appears in command output or session logs. If plan usage is not granted, the plugin keeps the sign-in but requests fail with `SIWC_PLAN_USAGE_DISABLED` — sign in again and allow it.

## Usage

- Pick a model under **ChatGPT plan (Sign in with ChatGPT)** in the model picker. The list comes from your account's `GET /v1/models` (only `visibility: "list"` entries) and refreshes when you switch accounts.
- Supported: text, streaming, multi-turn conversations, tool calls (wrapped in a namespace named `dsh`, as the docs require), image input, and reasoning effort. Model capabilities — input types, context window, reasoning levels — come from the account's model catalog; nothing is guessed.
- Slash commands (when DSH mounts the commands service):
  - `/siwc login [new]` — sign in (see above);
  - `/siwc status` — sign-in state, plan usage, granted scopes, token lifetime, the last sign-in failure and model-list error (never any token);
  - `/siwc models` — fetch the current account's model list;
  - `/siwc logout` — sign out (see below).

### Differences from other providers

| DSH parameter | Behavior | Why |
|---|---|---|
| `temperature` | **Error** `UNSUPPORTED_PARAMETER` | Forbidden by the docs; silently dropping it would change the output |
| `stop` | **Error** `UNSUPPORTED_PARAMETER` | The Responses API has no stop sequences |
| `reasoningEffort` | Sent as `reasoning.effort` | Levels come from the account catalog, intersected with the values the API accepts (the catalog's `ultra` is rejected by the API and therefore dropped). "Default" leaves the server's own default |
| `maxTokens` | **Not sent**, logged once | The docs forbid `max_output_tokens`. DSH's compaction and session titles always pass it; it is only a cap, so omitting it does not affect correctness |
| Image input | Image-capable models (per catalog): inline data URLs, including images in tool results. Text-only models: text placeholders | At most 20 MiB of base64 images per request by default (`maxRequestImageBytes`); beyond that DSH offloads the oldest images |
| Reasoning replay | Not replayed | `store: false`, and no encrypted reasoning content is available |

## Sign out

```
/siwc logout
```

Stops using the tokens, revokes the refresh token with OpenAI (retrying on failure), then deletes the local tokens. The issued client id and this host's id are kept for the next sign-in. If revocation cannot be confirmed, the plugin says so; you can then disconnect the app in ChatGPT settings.

> Deleting the `openai-siwc/session` record in DSH settings is **local only** and does not revoke the session remotely.

## Uninstall

1. Run `/siwc logout` first (revokes the remote session);
2. `"$DSH" plugin --profile <profile> remove @hackforjoy/dsh-openai-siwc`, then restart DSH;
3. Uninstalling does **not** delete credential records (by DSH design). For a full cleanup, delete `openai-siwc/session` and `openai-siwc/registry` in DSH settings. Without the registry, the next sign-in registers a new client and host id.

## Credential storage

Credentials live in the DSH credential store (default `~/.dsh/.credentials.yaml`, mode `0600`, atomic writes) as two records:

- `openai-siwc/registry` — this host's id (`urn:uuid:…`) and registered accounts (client_id, sub, email);
- `openai-siwc/session` — the current account's access/refresh/ID tokens, granted scopes, and expiry.

Refresh runs inside DSH's cross-process exclusive write, so several DSH processes never race a rotating refresh token. See [`docs/security/threat-model.md`](docs/security/threat-model.md) for the security design and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Troubleshooting

| Symptom / code | Cause and fix |
|---|---|
| `MISSING_CREDENTIAL` | Not signed in. Run `/siwc login` |
| `SIWC_PLAN_USAGE_DISABLED` | Plan usage was not granted at sign-in. Run `/siwc login` and allow it |
| Sign-in fails with `invalid_grant` | Most often the account is not Plus/Pro (Free accounts are refused at the code exchange). After upgrading, run `/siwc login` again; the plugin reuses the client id it kept |
| "Could not open the system browser" | No system browser could be launched (e.g. a headless machine); the plugin only supports running locally |
| Sign-in reports "declined in the browser" | Authorization was declined. Sign in again and allow it, or use another provider (such as your own API key) |
| Sign-in reports "Registration incomplete" | The callback carried no issued client_id. Sign in again |
| Sign-in reports "ID token failed validation" | The ID token failed signature or claim checks and was not stored. Check the system clock and retry |
| `QUOTA` (`subscription_sharing_usage_limit_exceeded`) | ChatGPT plan usage limit reached (possibly a per-app limit). See <https://chatgpt.com/settings/usage>. Not retried automatically |
| `SIWC_NOT_ELIGIBLE` | Plan usage is unavailable for this user, workspace, or policy. Not retried |
| `SIWC_UNSUPPORTED_CAPABILITY` | The request used an unsupported input, tool, or model; `param=` in the message names it |
| `AUTH` (401) | The token or permission was not accepted. Check `/siwc status`; sign in again only after the session is confirmed revoked |
| `SERVER` (503, e.g. `usage_unavailable`) | Temporary; DSH retries per its retry policy and credentials are kept |
| `TRANSPORT`: "stream ended before response.completed" | Connection interrupted; retry |
| Empty model list | Not signed in, or the fetch failed; `/siwc status` shows the last error |

Every error message includes the HTTP status and OpenAI's request id when available, and never a token.

## Development

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck   # tsc --noEmit (including tests)
pnpm test        # vitest: unit + integration tests (real DSH services + local mock OpenAI)
pnpm build       # output to lib/
pnpm pack:verify # pack and print the SHA-256 of the build artifact
```

Install a local build into DSH: `"$DSH" plugin --profile <profile> add "file:/absolute/path/hackforjoy-dsh-openai-siwc-<version>.tgz"`. Re-installing the same version requires `remove` then `add`.

The integration tests mount the real `@deepseek-ai/dsh-llm`, `dsh-authorization`, `dsh-credentials-local`, and `dsh-attachment-local` (all on temp directories) against `tests/helpers/mock-openai.ts`. The mock implements the official protocol strictly — PKCE is verified, `redirect_uri`/`resource`/`client_id` must match, refresh tokens rotate and reuse is rejected, forbidden fields are refused — and reproduces live behavior observed on the real endpoint (SSE without `Content-Type`, `x-oai-request-id`). `DSH_HOME` points at a temp directory, so tests never touch a real `~/.dsh`.

Releases on npm are published from GitHub Actions with npm Trusted Publishing and carry provenance; the npm page (or `npm view @hackforjoy/dsh-openai-siwc --json`) links each version to the source commit and workflow run that built it.

See [CONTRIBUTING.md](CONTRIBUTING.md) to contribute and [CHANGELOG.md](CHANGELOG.md) for release notes.

## Verification status and limitations

- **Verified against the real service (DSH 0.2.1-rc.3, an eligible ChatGPT account)**: sign-in, sign-in again after logout, model list, streaming text, multi-turn, tool-call round trips, token refresh and rotation, reasoning effort, image input, logout with remote revocation; no tokens in logs or session files.
- Not yet verified against the real service: adding a second account with `/siwc login new`; a real `IMAGE_OFFLOAD_REQUIRED` (the server's image limit is unpublished).
- Behavior the official docs leave open, as observed on the real service: [`docs/research/openai-siwc-protocol.md` §16](docs/research/openai-siwc-protocol.md).
- One active account at a time (several can be saved and chosen at sign-in).
- Architecture decisions: [`docs/adr/ADR-001-siwc-provider-plugin.md`](docs/adr/ADR-001-siwc-provider-plugin.md).

## License

MIT — see [LICENSE](LICENSE).
