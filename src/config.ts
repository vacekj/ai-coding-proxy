import { homedir } from "node:os";
import { join } from "node:path";

export const XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
export const XAI_SCOPE = "openid profile email offline_access grok-cli:access api:access";
export const XAI_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
export const GROK_CLI_DEFAULT_API_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
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
  const raw = process.env.PORT ?? "8317";
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return port;
}

export function oauthCallbackPort(): number {
  const raw = process.env.XAI_OAUTH_CALLBACK_PORT ?? String(XAI_CALLBACK_PORT);
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid XAI_OAUTH_CALLBACK_PORT: ${raw}`);
  }
  return port;
}
