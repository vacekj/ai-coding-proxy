# AI Coding Proxy

[![CI](https://github.com/vacekj/ai-coding-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/vacekj/ai-coding-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A tiny Bun/TypeScript Anthropic Messages API proxy for Claude Code. Run one local server and route requests to supported upstreams — without giving Claude Code an API key.

It supports:

- **Grok Composer** through Grok CLI OAuth, using `grok-composer-2.5-fast`
- **OpenCode Zen** free tier through `zen/` model IDs such as `zen/mimo-v2.5-free`
- **OpenCode Go** subscription through `go/` model IDs such as `go/glm-5.3`
- **GLM-5.3-Flash** through OpenRouter and Nous Portal as `openrouter/glm-5.3-flash` and `hermes/glm-5.3-flash`

The proxy does not accept API keys from local clients and does not implement its own OAuth flow. For Grok, it only reads the token created by `grok login --oauth`; for OpenCode Go, it only reads the key created by `opencode auth login`. GLM-5.3-Flash's OpenRouter and Nous gateways are the exception: they take a key from the environment.

## When to use this

- You want to use [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) but route to a non-Anthropic model (Grok, OpenCode, GLM-5.3-Flash) for cost or experimentation.
- You want GLM-5.3-Flash with its 1,048,576-token context window and 131,072-token output limit.
- You want OpenCode Zen's free model tier working inside Claude Code without a Zen API key.
- You have an OpenCode Go subscription and want its models in the Claude Code model picker.
- You want a single local endpoint that can talk to multiple backends, switching by model name.

## When *not* to use this

- You need production-grade reliability, observability, or auth — this is a ~1k-line local dev proxy.
- You want a generic OpenAI/Anthropic protocol bridge. This is shaped specifically around Claude Code's request shape.

## Quick Start

Requirements:

- [Bun](https://bun.sh/)
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
- Grok CLI, if you want Grok Composer

Install dependencies and log in to Grok:

```bash
bun install
bun run login
```

Start the local proxy:

```bash
bun run start
```

In another terminal, point Claude Code at the proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_MODEL=grok-composer-2.5-fast
export ANTHROPIC_DEFAULT_SONNET_MODEL=grok-composer-2.5-fast
export ANTHROPIC_DEFAULT_OPUS_MODEL=grok-composer-2.5-fast
export ANTHROPIC_CUSTOM_MODEL_OPTION=grok-composer-2.5-fast
export ANTHROPIC_CUSTOM_MODEL_OPTION_NAME="Composer 2.5 Fast"
export ANTHROPIC_CUSTOM_MODEL_OPTION_SUPPORTED_CAPABILITIES=effort,thinking,adaptive_thinking,interleaved_thinking
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1
claude
```

That is the normal happy path.

## GLM-5.3-Flash

GLM-5.3-Flash (the model previously previewed as Ox Alpha) is registered once per upstream so you can switch or recover from a provider-specific rate limit without changing protocol adapters:

| Model ID | Upstream | Credentials |
| --- | --- | --- |
| `openrouter/glm-5.3-flash` | OpenRouter | `OPENROUTER_API_KEY` |
| `hermes/glm-5.3-flash` | Nous Portal | `NOUS_API_KEY` |
| `go/glm-5.3-flash` | OpenCode Go | `opencode-go` key from the OpenCode CLI |

The OpenRouter and Nous routes send the upstream model ID `z-ai/glm-5.3-flash`. OpenCode Go sends `glm-5.3-flash`. They preserve tool calls, screenshots, and reasoning across Claude Code turns. The old `openrouter/ox-alpha`, `hermes/ox-alpha`, and `go/ox-alpha-free` ids still resolve.

Reasoning cannot be disabled. The proxy maps Claude Code effort onto `low`, `high`, and `max`.

### OpenRouter

Create an OpenRouter key, then start Claude Code with:

```bash
export OPENROUTER_API_KEY=your-openrouter-key
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_MODEL=openrouter/glm-5.3-flash
export ANTHROPIC_DEFAULT_SONNET_MODEL=openrouter/glm-5.3-flash
export ANTHROPIC_DEFAULT_OPUS_MODEL=openrouter/glm-5.3-flash
export ANTHROPIC_API_KEY=not-needed
export ANTHROPIC_AUTH_TOKEN=not-needed
claude
```

### Nous Portal

Create a key at [portal.nousresearch.com](https://portal.nousresearch.com), then:

```bash
export NOUS_API_KEY=your-nous-key
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_MODEL=hermes/glm-5.3-flash
export ANTHROPIC_DEFAULT_SONNET_MODEL=hermes/glm-5.3-flash
export ANTHROPIC_DEFAULT_OPUS_MODEL=hermes/glm-5.3-flash
export ANTHROPIC_API_KEY=not-needed
export ANTHROPIC_AUTH_TOKEN=not-needed
claude
```

Nous bills this model. A zero portal balance returns a credits error rather than serving it.

## OpenCode

OpenCode models are served from the same local server, under two prefixes:

| Prefix | Catalog | Credentials |
| --- | --- | --- |
| `zen/` | OpenCode Zen free tier (7 models) | none |
| `go/` | OpenCode Go subscription (23 models) | `opencode-go` key from the OpenCode CLI |

Only models verified to answer a live request are registered. Paid Zen models are
deliberately absent: they bill against a Zen credit balance, which an OpenCode Go
subscription does not provide.

### Zen free tier

No credentials at all:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_MODEL=zen/mimo-v2.5-free
export ANTHROPIC_DEFAULT_SONNET_MODEL=zen/mimo-v2.5-free
export ANTHROPIC_DEFAULT_OPUS_MODEL=zen/mimo-v2.5-free
export ANTHROPIC_API_KEY=not-needed
export ANTHROPIC_AUTH_TOKEN=not-needed
claude
```

### Go subscription

Log in once with the OpenCode CLI, which writes the key to
`~/.local/share/opencode/auth.json`; the proxy reads it from there.

```bash
opencode auth login   # choose OpenCode Go
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_MODEL=go/glm-5.3
export ANTHROPIC_API_KEY=not-needed
export ANTHROPIC_AUTH_TOKEN=not-needed
claude
```

`go/deepseek-v4-pro` and `go/deepseek-v4-flash` are not registered: OpenCode serves the
current versions from China only, and returns `RegionError` until that is opted into per
workspace at `https://opencode.ai/workspace/<workspace-id>/go`. `go/deepseek-v4-flash-vision-exp`
needs no opt-in and is registered. Opt in and the other two can be added to `GO_MODELS`
in `src/opencode.ts`.

Registered model IDs are exposed through:

```bash
curl http://127.0.0.1:8317/v1/models
```

The proxy accepts `zen/<id>`, `go/<id>`, the legacy `opencode/<id>` alias, and bare model
IDs. A bare ID resolves to Zen first, then Go.

## Configuration

Copy `.env.example` if you want a local starting point:

```bash
cp .env.example .env
```

The app reads environment variables directly; use your shell, direnv, or another dotenv loader.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Local bind host |
| `PORT` | `8317` | Local HTTP port |
| `GROK_PROXY_MODEL` | `grok-composer-2.5-fast` | Upstream Grok CLI model |
| `GROK_PROXY_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Grok CLI API base URL |
| `GROK_CLI_AUTH_FILE` | `~/.grok/auth.json` | Grok CLI OAuth credential file |
| `OPENCODE_API_KEY` | unset | Optional OpenCode Zen API key; the free tier does not need one |
| `OPENCODE_AUTH_FILE` | `~/.local/share/opencode/auth.json` | OpenCode CLI credential file holding the `opencode-go` key |
| `OPENCODE_PROXY_MODEL` | `zen/mimo-v2.5-free` | Default OpenCode model when `PROXY_PROVIDER=opencode` |
| `OPENCODE_OPENAI_BASE_URL` | `https://opencode.ai/zen/v1/chat/completions` | Zen OpenAI-compatible endpoint |
| `OPENCODE_ANTHROPIC_BASE_URL` | `https://opencode.ai/zen/v1/messages` | Zen Anthropic Messages endpoint |
| `OPENCODE_GO_OPENAI_BASE_URL` | `https://opencode.ai/zen/go/v1/chat/completions` | Go OpenAI-compatible endpoint |
| `OPENCODE_GO_ANTHROPIC_BASE_URL` | `https://opencode.ai/zen/go/v1/messages` | Go Anthropic Messages endpoint |
| `OPENROUTER_API_KEY` | unset | OpenRouter key for `openrouter/glm-5.3-flash` |
| `OPENROUTER_OPENAI_BASE_URL` | `https://openrouter.ai/api/v1/chat/completions` | OpenRouter chat-completions endpoint |
| `NOUS_API_KEY` | unset | Nous Portal key for `hermes/glm-5.3-flash` |
| `NOUS_OPENAI_BASE_URL` | `https://inference-api.nousresearch.com/v1/chat/completions` | Nous Portal chat-completions endpoint |
| `PROXY_PROVIDER` | unset | Route unrecognized model names to `opencode`, `openrouter`, `hermes`, or `nous` |
| `PROXY_MAX_TOOL_RESULT_CHARS` | `24000` | Max characters kept from a single `tool_result` before head/tail truncation |
| `PROXY_MAX_REQUEST_CHARS` | `200000` | Approximate serialized Anthropic request budget before older tool results are compacted harder |
| `PROXY_COMPACTED_TOOL_RESULT_CHARS` | `4000` | Max characters kept for older tool results during whole-request compaction |
| `PROXY_IDLE_TIMEOUT_SECONDS` | `255` | Bun server idle timeout for long upstream requests |
| `PROXY_STREAM_PING_MS` | `4000` | Anthropic SSE `ping` interval while waiting for non-streaming upstream responses |

For smaller-context models such as `zen/mimo-v2.5-free`, keep the request budget conservative. If huge tool results cause upstream `ECONNRESET` failures, try:

```bash
export PROXY_MAX_REQUEST_CHARS=120000
export PROXY_MAX_TOOL_RESULT_CHARS=12000
export PROXY_COMPACTED_TOOL_RESULT_CHARS=2000
```

For DeepSeek V4 models, Claude Code effort is translated to DeepSeek reasoning modes: `none`/`minimal`/disabled thinking becomes `none`, normal Claude `low`/`medium`/`high`/adaptive thinking becomes `high`, and `max`/`xhigh` or very large thinking budgets become `max`. OpenCode receives this as top-level `reasoning_effort`.

If a client or network path closes long streaming requests, increase `PROXY_IDLE_TIMEOUT_SECONDS` or lower `PROXY_STREAM_PING_MS`.

## Local Endpoints

- `GET /health` returns current proxy settings.
- `GET /v1/models` lists Grok, GLM-5.3-Flash, and registered OpenCode `zen/` and `go/` model IDs.
- `POST /v1/messages` handles Anthropic-compatible message requests.
- `POST /anthropic/v1/messages` is an alias for clients that include the Anthropic prefix.
- `POST /v1/messages/count_tokens` returns the proxy's rough token estimate and sanitization stats.

## Checks

Fast local checks:

```bash
bun run typecheck
bun test
```

Live checks against real upstream services:

```bash
bun run smoke
bun run test:live
```

`bun run smoke` expects the proxy to already be running. It loads the Grok CLI token from `~/.grok/auth.json`, sends one direct request to the Grok CLI Responses API, then sends one request through the local Anthropic-compatible proxy.

`bun run test:live` starts a local proxy on port `8329`, sends real requests to Grok Composer and OpenCode Zen, asks for real tool calls, executes `pwd`, and feeds the real tool result back through the proxy.

## Notes

- Grok credentials are separate from OpenCode credentials.
- OpenRouter and Nous Portal each apply their own availability and rate limits to GLM-5.3-Flash.
- If Grok credentials are missing or expired, run `bun run login`.
- If Go requests fail on credentials, run `opencode auth login` and choose OpenCode Go.
- Local proxy clients are unauthenticated, so keep the default `HOST=127.0.0.1` unless you intentionally want to expose it.

## License

[MIT](./LICENSE) — see [`LICENSE`](./LICENSE) for the full text.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).
