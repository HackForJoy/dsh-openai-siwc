# Contributing

Thanks for helping! Issues and pull requests are welcome.

## Ground rules

- **The official SIWC documentation is the only protocol source.** Cite the page for any endpoint, parameter, or behavior you add. If the docs are silent, say so and, where possible, back it with an observation recorded in [`docs/research/openai-siwc-protocol.md`](docs/research/openai-siwc-protocol.md) §16.
- **Do not bypass server controls** (eligibility, model access, rate or usage limits) and do not reuse other tools' credentials or ChatGPT web endpoints.
- **Never commit real tokens**, authorization codes, callback URLs, credential files, or logs from a real session. Tests use the mock in `tests/helpers/mock-openai.ts`.
- Keep the plugin free of DSH core changes; use the public services (`ctx.llm`, `ctx.credentials`, `ctx.authorization`, `ctx.commands`, `ctx.attachments`).

## Development

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check   # typecheck + tests + build
```

Add or update tests with every behavior change. Tests must stay offline and must not touch a real `~/.dsh` (the test setup points `DSH_HOME` at a temp directory).

## Pull requests

- One focused change per PR, with a short description of the why.
- Update `README.md` and `README.zh.md` together when user-facing behavior changes, and add an entry under "Unreleased" in [CHANGELOG.md](CHANGELOG.md).
- CI (typecheck, tests, build on Node 22 and 24) must pass.

## Releasing (maintainers)

1. Update `version` in `package.json` and move the "Unreleased" notes in `CHANGELOG.md` under the new version.
2. Commit, then tag `v<version>` and push the tag.
3. The `release` workflow verifies the tag matches `package.json`, runs `pnpm check`, and creates a GitHub Release with the CHANGELOG notes, the npm tarball, and `SHA256SUMS`.
4. When the repository variable `NPM_TRUSTED_PUBLISHING` is `true`, the same workflow publishes to npm through **npm Trusted Publishing** (GitHub OIDC, no stored token) with provenance. A version already on npm is skipped, so the job can be re-run.

When the DSH SDK version changes, update the exact `@deepseek-ai/*` peer and dev versions, re-run the tests, and verify against the matching DSH release before publishing.
