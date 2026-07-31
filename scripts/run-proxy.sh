#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE="${AI_CODING_PROXY_ENV:-$HOME/.config/ai-coding-proxy/env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/run/current-system/sw/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  echo "bun not found on PATH (expected \$HOME/.bun/bin/bun)" >&2
  exit 1
fi
exec bun run src/server.ts
