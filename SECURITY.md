# Security Policy

This plugin handles OAuth tokens that can spend a user's ChatGPT plan, so security reports are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue.** Report privately through GitHub's
[private vulnerability reporting](https://github.com/HackForJoy/dsh-openai-siwc/security/advisories/new)
("Security" tab → "Report a vulnerability").

Include the affected version, a description of the issue, and reproduction steps. **Never include real access, refresh, or ID tokens, authorization codes, or full callback URLs** — redact them; a reproduction against the mock server in `tests/helpers/mock-openai.ts` is ideal.

You can expect an acknowledgement within 7 days. Fixes are released as a new npm version and noted in the [CHANGELOG](CHANGELOG.md).

## Supported versions

Only the latest published version receives security fixes.

## Scope

In scope: token handling and storage, the OAuth flow (state/PKCE/nonce, callback listener, ID token validation), redaction of logs and diagnostics, and request construction.

Out of scope: vulnerabilities in DeepSeek Harness itself or in OpenAI services — report those to their maintainers. The design and its known residual risks are documented in [`docs/security/threat-model.md`](docs/security/threat-model.md).

If you believe a token has been exposed, disconnect the app in ChatGPT settings (<https://chatgpt.com/settings>) and run `/siwc logout`.
