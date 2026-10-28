# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] - 2026-10-28

First release. Compatible with DeepSeek Harness 0.2.1-rc.3.

### Added

- `openai-siwc` LLM provider for DeepSeek Harness using OpenAI Sign in with ChatGPT (ChatGPT plan usage for open-source clients).
- Sign-in through `/siwc login [new]`: dynamic client registration, `127.0.0.1` loopback callback, PKCE S256, state and nonce, ID token validation against the published JWKS, plan-usage scope check; the issued client id is kept across a failed code exchange.
- Credentials in the DSH credential store with cross-process serialized refresh; `/siwc logout` revokes the session remotely.
- Streaming inference over the Responses API (`store: false`, `stream: true`), tool calls in a namespace, multi-turn history, error mapping per the official recovery guidance.
- Model capabilities from the account catalog: input modalities, context window, and reasoning efforts (limited to values the API accepts); inline image input with DSH's image-offload budget.
- `/siwc status` and `/siwc models` diagnostics with redaction.

[Unreleased]: https://github.com/HackForJoy/dsh-openai-siwc/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/HackForJoy/dsh-openai-siwc/releases/tag/v0.1.0
