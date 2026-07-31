#!/usr/bin/env bash
set -euo pipefail
# DEPRECATED (2026-07): homie now runs ai-coding-proxy natively via systemd user
# service ai-coding-proxy.service. Do not re-enable this reverse tunnel — it made
# OCR depend on the MacBook being awake.
#
# Historical: expose Mac's local ai-coding-proxy (:8317) on homie's 127.0.0.1:8317
echo "homie-reverse-tunnel.sh is deprecated — ai-coding-proxy runs on homie via systemd." >&2
exit 1
