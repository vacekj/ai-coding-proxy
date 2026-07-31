import { homedir } from "node:os";
import { join } from "node:path";

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export const GROK_CLI_DEFAULT_API_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
export const OPENCODE_ZEN_OPENAI_BASE_URL = "https://opencode.ai/zen/v1/chat/completions";
export const OPENCODE_ZEN_ANTHROPIC_BASE_URL = "https://opencode.ai/zen/v1/messages";
export const CLINE_API_BASE_URL = "https://api.cline.bot";
export const XAI_REDIRECT_HOST = "127.0.0.1";
export const XAI_REDIRECT_PATH = "/callback";
export const XAI_CALLBACK_PORT = 56121;
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
  return process.env.OPENCODE_PROXY_MODEL ?? "mimo-v2.5-free";
}

export function opencodeApiKey(): string | undefined {
  return process.env.OPENCODE_API_KEY?.trim() || undefined;
}

export function clineDefaultModel(): string {
  return process.env.CLINE_PROXY_MODEL ?? "kimi-k3";
}

export function clineApiKey(): string | undefined {
  return process.env.CLINE_API_KEY?.trim() || undefined;
}

export function clineApiBaseUrl(): string {
  return (process.env.CLINE_API_BASE ?? CLINE_API_BASE_URL).replace(/\/+$/, "");
}

export function clineChatCompletionsUrl(): string {
  const base = clineApiBaseUrl();
  if (base.endsWith("/chat/completions")) return base;
  if (base.endsWith("/api/v1")) return `${base}/chat/completions`;
  return `${base}/api/v1/chat/completions`;
}

export function clineRefreshUrl(): string {
  const base = clineApiBaseUrl();
  if (base.endsWith("/api/v1")) return `${base}/auth/refresh`;
  return `${base}/api/v1/auth/refresh`;
}

export function clineProvidersFilePath(): string {
  return expandHome(
    process.env.CLINE_PROVIDERS_FILE ?? join(homedir(), ".cline", "data", "settings", "providers.json"),
  );
}

export function opencodeOpenAIBaseUrl(): string {
  return (process.env.OPENCODE_OPENAI_BASE_URL ?? OPENCODE_ZEN_OPENAI_BASE_URL).replace(/\/+$/, "");
}

export function opencodeAnthropicBaseUrl(): string {
  return (process.env.OPENCODE_ANTHROPIC_BASE_URL ?? OPENCODE_ZEN_ANTHROPIC_BASE_URL).replace(/\/+$/, "");
}

export function apiBaseUrl(): string {
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

export function oauthCallbackPort(): number {
  return portEnv("XAI_OAUTH_CALLBACK_PORT", XAI_CALLBACK_PORT);
}

function portEnv(name: string, fallback: number): number {
  const raw = process.env[name] ?? String(fallback);
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return port;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${name}: ${raw}`);
  }
  return value;
}
