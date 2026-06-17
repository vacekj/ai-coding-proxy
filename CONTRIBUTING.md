# Contributing

Thanks for your interest in `ai-coding-proxy`. This is a small, fast-moving project; the contribution bar is intentionally low.

## Local setup

Requirements: [Bun](https://bun.sh/).

```bash
bun install
bun run typecheck
bun test
```

The `bun run test:live` and `bun run smoke` scripts hit real upstream services (Grok CLI, OpenCode Zen) and require valid credentials. They are not part of CI and should not be required for a PR to land.

## Project layout

```
src/                       Proxy source (server.ts is the entry point)
  anthropic-stream.ts      Anthropic SSE stream + ping keepalive
  config.ts                Env loading and defaults
  nvidia.ts                NVIDIA NIM adapter (model list, request/response translation)
  opencode.ts              OpenCode Zen adapter (model list, shared OpenAI chat translation)
  oauth.ts                 Grok CLI OAuth token handling
  sanitize.ts              Oversized-request compaction
  server.ts                Bun.serve entry + endpoint routing
  sse.ts                   SSE encoding helpers
  translate.ts             Anthropic ↔ OpenAI Responses format
  types.ts                 Shared types
  xai.ts                   Grok CLI Responses API client

test/                      Unit tests (bun test)
scripts/smoke.ts           Live smoke check against real upstreams
```

## Making a change

1. Branch from `main`.
2. Keep the diff focused. One change per PR.
3. Add or update tests for non-trivial logic. The unit tests under `test/` are the only ones CI runs; live tests are opt-in.
4. Run `bun run typecheck` and `bun test` locally before pushing.
5. Open a PR with a short description of *what* changed and *why*. If it touches model routing, request/response translation, or the SSE stream, call that out explicitly.

## Style

- TypeScript, ESM, Bun runtime. No transpiler config beyond `tsconfig.json`.
- Match the existing style: small, named functions over deep nesting; prefer explicit env reads at the top of a module; keep the public surface area of each module small.
- No external runtime dependencies. The only `devDependencies` are `@types/bun` and `typescript`.

## Reporting bugs

Use the [bug report issue template](https://github.com/vacekj/ai-coding-proxy/issues/new?template=bug_report.md).
