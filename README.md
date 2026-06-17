# AI Coding Proxy

[![CI](https://github.com/vacekj/ai-coding-proxy/actions/workflows/ci.yml/badge.svg)](https://github.com/vacekj/ai-coding-proxy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

A tiny Bun/TypeScript Anthropic Messages API proxy for Claude Code. Run one local server and route requests to supported upstreams — without giving Claude Code an API key.

It supports:

- **Grok Composer** through Grok CLI OAuth, using `grok-composer-2.5-fast`
- **OpenCode Zen** through Zen model IDs such as `opencode/minimax-m3-free`
- **NVIDIA NIM** through model IDs such as `nvidia/deepseek-v4-pro`

The proxy does not accept API keys from local clients and does not implement its own OAuth flow. For Grok, it only reads the token created by `grok login --oauth`.

## When to use this

- You want to use [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) but route to a non-Anthropic model (Grok, OpenCode Zen, NVIDIA NIM) for cost or experimentation.
- You want OpenCode Zen's free model tier working inside Claude Code without a Zen API key.
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

## OpenCode Zen

OpenCode Zen models are available from the same local server. Use an `opencode/` model ID in Claude Code:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_MODEL=opencode/minimax-m3-free
export ANTHROPIC_DEFAULT_SONNET_MODEL=opencode/minimax-m3-free
export ANTHROPIC_DEFAULT_OPUS_MODEL=opencode/minimax-m3-free
export ANTHROPIC_API_KEY=not-needed
export ANTHROPIC_AUTH_TOKEN=not-needed
claude
```

The tested free Zen model path works without a key. For paid or key-gated Zen models, use `/connect` in OpenCode, select OpenCode Zen, and set:

```bash
export OPENCODE_API_KEY=...
```

Known Zen model IDs are exposed through:

```bash
curl http://127.0.0.1:8317/v1/models
```

The proxy accepts both `opencode/<model-id>` and raw Zen model IDs.

## NVIDIA NIM

NVIDIA NIM models are available from the same local server with an `nvidia/` prefix:

```bash
export NVIDIA_API_KEY=...
export ANTHROPIC_BASE_URL=http://127.0.0.1:8317
export ANTHROPIC_MODEL=opus[1m]
export ANTHROPIC_DEFAULT_OPUS_MODEL='nvidia/deepseek-v4-pro[1m]'
export ANTHROPIC_DEFAULT_OPUS_MODEL_NAME="NVIDIA DeepSeek V4 Pro"
export ANTHROPIC_DEFAULT_OPUS_MODEL_SUPPORTED_CAPABILITIES=effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking
export ANTHROPIC_DEFAULT_SONNET_MODEL='nvidia/deepseek-v4-pro[1m]'
export ANTHROPIC_DEFAULT_SONNET_MODEL_NAME="NVIDIA DeepSeek V4 Pro"
export ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES=effort,xhigh_effort,max_effort,thinking,adaptive_thinking,interleaved_thinking
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000
export ANTHROPIC_API_KEY=not-needed
export ANTHROPIC_AUTH_TOKEN=not-needed
claude
```

Known NVIDIA IDs:

- `nvidia/deepseek-v4-pro` maps to `deepseek-ai/deepseek-v4-pro`
- `nvidia/deepseek-v4-flash` maps to `deepseek-ai/deepseek-v4-flash`
- `nvidia/kimi-k2.6` maps to `moonshotai/kimi-k2.6`

The DeepSeek V4 models are advertised by NVIDIA with 1M-token context windows; Kimi K2.6 is advertised at 256K. Claude Code only applies 1M local context accounting to recognized aliases with the `[1m]` suffix, so the recommended setup maps `opus[1m]`/`sonnet[1m]` to the NVIDIA DeepSeek model. The proxy strips `[1m]` before routing upstream.

NVIDIA-routed requests compact old tool results based on the selected model's context window: 1M-context DeepSeek V4 models compact at roughly 900K serialized request characters, while 256K-context models such as Kimi K2.6 compact at roughly 200K.

Set Claude Code's own auto-compaction window to the matching budget when launching it: `CLAUDE_CODE_AUTO_COMPACT_WINDOW=900000` for the DeepSeek 1M models, or `CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000` for Kimi K2.6.

NVIDIA's preview NIM endpoints are severely rate limited. They are useful for quick experiments, but they are not a reliable daily-driver backend for Claude Code; expect intermittent or frequent `429 Too Many Requests` responses, especially with long-context DeepSeek requests or repeated retries. When that happens, the proxy is usually working correctly and NVIDIA is rejecting the request upstream.

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
| `OPENCODE_API_KEY` | unset | Optional OpenCode Zen API key for paid/keyed Zen models |
| `OPENCODE_PROXY_MODEL` | `minimax-m3-free` | Default Zen model when `PROXY_PROVIDER=opencode` |
| `OPENCODE_OPENAI_BASE_URL` | `https://opencode.ai/zen/v1/chat/completions` | Zen OpenAI-compatible endpoint |
| `OPENCODE_ANTHROPIC_BASE_URL` | `https://opencode.ai/zen/v1/messages` | Zen Anthropic Messages endpoint |
| `NVIDIA_API_KEY` | unset | NVIDIA NIM API key |
| `NVIDIA_PROXY_MODEL` | `deepseek-v4-pro` | Default NVIDIA model when `PROXY_PROVIDER=nvidia` |
| `NVIDIA_OPENAI_BASE_URL` | `https://integrate.api.nvidia.com/v1` | NVIDIA OpenAI-compatible base URL, or full `/chat/completions` URL |
| `PROXY_PROVIDER` | unset | Set to `opencode` or `nvidia` to route unrecognized model names to that provider |
| `PROXY_MAX_TOOL_RESULT_CHARS` | `24000` | Max characters kept from a single `tool_result` before head/tail truncation |
| `PROXY_MAX_REQUEST_CHARS` | `200000` | Approximate serialized Anthropic request budget before older tool results are compacted harder |
| `PROXY_COMPACTED_TOOL_RESULT_CHARS` | `4000` | Max characters kept for older tool results during whole-request compaction |
| `PROXY_IDLE_TIMEOUT_SECONDS` | `255` | Bun server idle timeout for long upstream requests |
| `PROXY_STREAM_PING_MS` | `4000` | Anthropic SSE `ping` interval while waiting for non-streaming upstream responses |

NVIDIA NIM preview models may return `429 Too Many Requests` even for valid requests with a valid key. Use OpenCode Zen or Grok for steadier Claude Code sessions, and treat NVIDIA as a constrained experimental path unless your NVIDIA account has enough quota.

For smaller-context Zen models such as `opencode/deepseek-v4-flash-free`, keep the request budget conservative. If huge tool results cause upstream `ECONNRESET` failures, try:

```bash
export PROXY_MAX_REQUEST_CHARS=120000
export PROXY_MAX_TOOL_RESULT_CHARS=12000
export PROXY_COMPACTED_TOOL_RESULT_CHARS=2000
```

For DeepSeek V4 models, Claude Code effort is translated to DeepSeek reasoning modes: `none`/`minimal`/disabled thinking becomes `none`, normal Claude `low`/`medium`/`high`/adaptive thinking becomes `high`, and `max`/`xhigh` or very large thinking budgets become `max`. OpenCode receives this as top-level `reasoning_effort`; NVIDIA receives it in `chat_template_kwargs`.

If a client or network path closes long streaming requests, increase `PROXY_IDLE_TIMEOUT_SECONDS` or lower `PROXY_STREAM_PING_MS`.

## Local Endpoints

- `GET /health` returns current proxy settings.
- `GET /v1/models` lists Grok, known OpenCode Zen, and known NVIDIA NIM model IDs.
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

- Grok credentials are separate from OpenCode Zen and NVIDIA NIM credentials.
- Keep `NVIDIA_API_KEY` in your shell, secret manager, or ignored local env file. Do not commit real NVIDIA keys.
- NVIDIA NIM preview endpoints are quota constrained; `429 Too Many Requests` usually means upstream rate limiting, not a missing local key or proxy routing bug.
- If Grok credentials are missing or expired, run `bun run login`.
- Local proxy clients are unauthenticated, so keep the default `HOST=127.0.0.1` unless you intentionally want to expose it.

## License

[MIT](./LICENSE) — see [`LICENSE`](./LICENSE) for the full text.

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md).
