import { createHash } from "node:crypto";
import type { AnthropicMessageRequest } from "./types";

/** Public routing context, not an authentication credential or quota identity. */
export function openCodeSessionId(input: AnthropicMessageRequest, supplied?: string | null): string {
  if (supplied && /^[\x21-\x7e]{1,256}$/.test(supplied)) return supplied;
  // Older stateless clients do not expose a conversation ID. Preserve affinity
  // across retries/continuations of the same initial user turn; do not rotate
  // IDs after upstream errors or when changing models. Never send prompt text.
  const firstUser = input.messages?.find((message) => message.role === "user");
  const digest = createHash("sha256").update(JSON.stringify(firstUser ?? null)).digest("hex");
  return `ai-proxy-${digest}`;
}

export function openCodeClientSession(headers: Headers): string | null {
  return headers.get("x-opencode-session") ?? headers.get("x-session-id") ??
    headers.get("x-claude-session-id") ?? headers.get("anthropic-session-id");
}
