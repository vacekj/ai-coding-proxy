import { homedir } from "node:os";
import { join } from "node:path";

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const GROK_CLI_DEFAULT_API_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const OPENCODE_ZEN_OPENAI_BASE_URL = "https://opencode.ai/zen/v1/chat/completions";
export const OPENCODE_ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/zen/v1/messages";
export const OPENCODE_GO_OPENAI_BASE_URL = "https://opencode.ai/zen/go/v1/chat/completions";
export const OPENCODE_GO_ANTHROPIC_BASE_URL = "https://opencode.ai/zen/go/v1/messages";
export const OPENROUTER_OPENAI_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
export const NOUS_OPENAI_BASE_URL = "https://inference-api.nousresearch.com/v1/chat/completions";
export const GROK_CLI_CLIENT_VERSION = "0.2.16";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function grokCliAuthFilePath(): string {
  return expandHome(process.env.GROK_CLI_AUTH_FILE ?? join(homedir(), ".grok", "auth.json"));
}

export function upstreamModel(): string {
  return process.env.GROK_PROXY_MODEL ?? "grok-composer-2.5-fast";
}

export function opencodeDefaultModel(): string {
  return process.env.OPENCODE_PROXY_MODEL ?? "zen/mimo-v2.5-free";
}

/** OpenCode CLI credential store; holds the `opencode-go` API key. */
export function opencodeAuthFilePath(): string {
  return expandHome(
    process.env.OPENCODE_AUTH_FILE ?? join(homedir(), ".local", "share", "opencode", "auth.json"),
  );
}

export function opencodeApiKey(): string | undefined {
  return process.env.OPENCODE_API_KEY?.trim() || undefined;
}

export function opencodeOpenAIBaseUrl(): string {
  return (process.env.OPENCODE_OPENAI_BASE_URL ?? OPENCODE_ZEN_OPENAI_BASE_URL).replace(/\/+$/, "");
}

export function opencodeAnthropicBaseUrl(): string {
  return (process.env.OPENCODE_ANTHROPIC_BASE_URL ?? OPENCODE_ZEN_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
}

export function opencodeGoOpenAIBaseUrl(): string {
  return (process.env.OPENCODE_GO_OPENAI_BASE_URL ?? OPENCODE_GO_OPENAI_BASE_URL).replace(/\/+$/, "");
}

export function opencodeGoAnthropicBaseUrl(): string {
  return (process.env.OPENCODE_GO_ANTHROPIC_BASE_URL ?? OPENCODE_GO_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
}

export function openRouterApiKey(): string | undefined {
  return process.env.OPENROUTER_API_KEY?.trim() || undefined;
}

export function openRouterOpenAIBaseUrl(): string {
  return (process.env.OPENROUTER_OPENAI_BASE_URL ?? OPENROUTER_OPENAI_BASE_URL).replace(
    /\/+$/,
    "",
  );
}

export function nousApiKey(): string | undefined {
  return process.env.NOUS_API_KEY?.trim() || undefined;
}

export function nousOpenAIBaseUrl(): string {
  return (process.env.NOUS_OPENAI_BASE_URL ?? NOUS_OPENAI_BASE_URL).replace(/\/+$/, "");
}

export function grokApiBaseUrl(): string {
  return (
    process.env.GROK_PROXY_BASE_URL ??
    process.env.GROK_CLI_BASE_URL ??
    process.env.XAI_API_BASE_URL ??
    GROK_CLI_DEFAULT_API_BASE_URL
  ).replace(/\/+$/, "");
}

export function serverHost(): string {
  return process.env.HOST ?? "127.0.0.1";
}

export function serverPort(): number {
  return portEnv("PORT", 8317);
}

export function maxToolResultChars(): number {
  return positiveIntEnv("PROXY_MAX_TOOL_RESULT_CHARS", 24_000);
}

export function maxRequestChars(): number {
  return positiveIntEnv("PROXY_MAX_REQUEST_CHARS", 200_000);
}

export function compactedToolResultChars(): number {
  return positiveIntEnv("PROXY_COMPACTED_TOOL_RESULT_CHARS", 4_000);
}

export function serverIdleTimeoutSeconds(): number {
  return positiveIntEnv("PROXY_IDLE_TIMEOUT_SECONDS", 255);
}

export function streamPingMs(): number {
  return positiveIntEnv("PROXY_STREAM_PING_MS", 4_000);
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}

function positiveIntEnv(name: string, fallback: number): number {
  return intEnv(name, fallback);
}

function portEnv(name: string, fallback: number): number {
  const value = intEnv(name, fallback);
  if (value > 65535) {
    throw new Error(`Invalid ${name}: ${process.env[name] ?? String(fallback)}`);
  }
  return value;
}
