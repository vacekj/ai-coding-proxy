import { readFile } from "node:fs/promises";
import { XAI_CLIENT_ID, apiBaseUrl, grokCliAuthFilePath } from "./config";
import type { GrokCliAuthFile, GrokCliAuthEntry, OAuthTokenFile } from "./types";

const EXPIRY_LEAD_SECONDS = 5 * 60;

export async function loadOAuthToken(): Promise<OAuthTokenFile> {
  const token = await loadGrokCliToken();
  if (!token) {
    throw new Error(
      `No usable Grok CLI OAuth token found in ${grokCliAuthFilePath()}. Run "grok login --oauth", then retry.`,
    );
  }
  if (isExpired(token)) {
    throw new Error(
      `Grok CLI OAuth token in ${grokCliAuthFilePath()} is expired or near expiry. Run "grok login --oauth", then retry.`,
    );
  }
  return token;
}

async function loadGrokCliToken(): Promise<OAuthTokenFile | undefined> {
  const path = grokCliAuthFilePath();
  let authFile: GrokCliAuthFile;
  try {
    authFile = JSON.parse(await readFile(path, "utf8")) as GrokCliAuthFile;
  } catch {
    return undefined;
  }

  const entry = findGrokCliAuthEntry(authFile);
  if (!entry?.key) return undefined;

  const identity = parseJWTIdentity(entry.key);
  return {
    type: "xai",
    auth_kind: "oauth",
    access_token: entry.key,
    refresh_token: entry.refresh_token,
    expires_at: isoToEpochSeconds(entry.expires_at) ?? identity?.exp,
    expired: entry.expires_at,
    base_url: apiBaseUrl(),
    email: typeof entry.email === "string" ? entry.email : identity?.email,
    sub:
      typeof entry.user_id === "string"
        ? entry.user_id
        : typeof entry.principal_id === "string"
          ? entry.principal_id
          : identity?.sub,
  };
}

function findGrokCliAuthEntry(authFile: GrokCliAuthFile): GrokCliAuthEntry | undefined {
  for (const [entryKey, entry] of Object.entries(authFile)) {
    if (!entry || typeof entry !== "object") continue;
    const matchesIssuer = entryKey.startsWith("https://auth.x.ai::");
    const matchesClient =
      entry.oidc_client_id === XAI_CLIENT_ID || entryKey.endsWith(`::${XAI_CLIENT_ID}`);
    if (matchesIssuer && matchesClient && typeof entry.key === "string" && entry.key) {
      return entry;
    }
  }
  return undefined;
}

function isExpired(token: OAuthTokenFile): boolean {
  if (!token.expires_at) return false;
  return Math.floor(Date.now() / 1000) + EXPIRY_LEAD_SECONDS >= token.expires_at;
}

function isoToEpochSeconds(value?: string): number | undefined {
  if (!value) return undefined;
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? Math.floor(millis / 1000) : undefined;
}

function parseJWTIdentity(token?: string): { email?: string; sub?: string; exp?: number } | undefined {
  if (!token) return undefined;
  const [, payload] = token.split(".");
  if (!payload) return undefined;
  try {
    const padded = payload + "=".repeat((4 - (payload.length % 4)) % 4);
    const claims = JSON.parse(Buffer.from(padded, "base64url").toString("utf8")) as {
      email?: string;
      sub?: string;
      exp?: number;
    };
    return { email: claims.email, sub: claims.sub, exp: claims.exp };
  } catch {
    return undefined;
  }
}
