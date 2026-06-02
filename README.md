# Grok Composer Claude Proxy

Tiny Bun/TypeScript Anthropic Messages API proxy for Claude Code, backed by xAI OAuth and `grok-composer-2.5-fast`.

## Setup

```bash
bun install
grok login --oauth
bun run start
```

Then launch Claude Code with:

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

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8317` | Local HTTP port |
| `HOST` | `127.0.0.1` | Local bind host |
| `GROK_PROXY_MODEL` | `grok-composer-2.5-fast` | Upstream Grok CLI model |
| `GROK_PROXY_BASE_URL` | `https://cli-chat-proxy.grok.com/v1` | Grok CLI API base URL |
| `GROK_CLI_AUTH_FILE` | `~/.grok/auth.json` | Grok CLI OAuth credential file |

This does not implement its own OAuth flow, inspect browser cookies, intercept OAuth traffic, accept API keys, or authenticate local proxy clients. If credentials are missing or expired, run `grok login --oauth`; the proxy only reads the token that Grok CLI stores in `~/.grok/auth.json`.

## Smoke test

With the proxy running:

```bash
bun run smoke
```

The smoke test loads the Grok CLI token from `~/.grok/auth.json`, sends one direct request to the Grok CLI Responses API, then sends one request through the local Anthropic-compatible proxy.

## Tests

```bash
bun test
```

The test suite uses no mocks or fixture responses. It loads the real Grok CLI OAuth token, sends real requests to the Grok CLI Responses API, starts a real local proxy on port `8329`, verifies the unauthenticated Anthropic-compatible response path, asks Composer for a real tool call, executes `pwd`, and feeds the real tool result back through the proxy.
