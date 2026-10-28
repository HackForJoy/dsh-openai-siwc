# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.2] - 2026-10-28

### Fixed

- Credential time fields are validated strictly. A token response whose `expires_in` is not a positive finite number (including `0`, negative values, and `1e999`, which JSON parses as `Infinity`) is rejected as malformed, so it is never saved as a session.
- A stored session whose `expiresAt` is not a positive finite number, or whose `earliestRefreshAt` is present but not a finite number, is treated as malformed: the plugin reports it as signed out instead of using its token.

## [0.1.1] - 2026-10-28

First release published from GitHub Actions through npm Trusted Publishing, with provenance. No functional changes.

### Changed

- README (English and Chinese) documents the GitHub Release assets and how to verify them (`sha256sum -c SHA256SUMS`), and notes that 0.1.0 was published manually without provenance.
- `pnpm pack:verify` builds the tarball with `npm pack`, matching how releases are packed.

## [0.1.0] - 2026-10-28

First release. Compatible with DeepSeek Harness 0.2.1-rc.3.

### Added

- `openai-siwc` LLM provider for DeepSeek Harness using OpenAI Sign in with ChatGPT (ChatGPT plan usage for open-source clients).
- Sign-in through `/siwc login [new]`: dynamic client registration, `127.0.0.1` loopback callback, PKCE S256, state and nonce, ID token validation against the published JWKS, plan-usage scope check; the issued client id is kept across a failed code exchange.
- Credentials in the DSH credential store with cross-process serialized refresh; `/siwc logout` revokes the session remotely.
- Streaming inference over the Responses API (`store: false`, `stream: true`), tool calls in a namespace, multi-turn history, error mapping per the official recovery guidance.
- Model capabilities from the account catalog: input modalities, context window, and reasoning efforts (limited to values the API accepts); inline image input with DSH's image-offload budget.
- `/siwc status` and `/siwc models` diagnostics with redaction.

[Unreleased]: https://github.com/HackForJoy/dsh-openai-siwc/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/HackForJoy/dsh-openai-siwc/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/HackForJoy/dsh-openai-siwc/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/HackForJoy/dsh-openai-siwc/releases/tag/v0.1.0
