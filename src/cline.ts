import {
  clineApiKey,
  clineChatCompletionsUrl,
  clineDefaultModel,
  clineProvidersFilePath,
  clineRefreshUrl,
} from "./config";
import {
  anthropicToOpenAI,
  openAIToAnthropic,
  type OpenAIChatModelConfig,
} from "./opencode";
import type {
  AnthropicMessageRequest,
  OpenAIChatCompletion,
  OpenAIChatRequest,
} from "./types";
import {
  type AnthropicMessage,
  estimateAnthropicInputTokens,
} from "./translate";

export interface ClineModelConfig extends OpenAIChatModelConfig {
  displayName: string;
  contextWindow: number;
  compactAtChars: number;
  maxOutputTokens: number;
  /** Models that only support max/high reasoning (e.g. Kimi K3). */
  alwaysMaxReasoning?: boolean;
}

export class ClineUpstreamError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ClineUpstreamError";
  }
}

interface ClineOAuthAuth {
  accessToken: string;
  refreshToken: string;
  expiresAt?: number | string;
  accountId?: string;
}

interface ClineProvidersFile {
  providers?: Record<
    string,
    {
      settings?: {
        auth?: Partial<ClineOAuthAuth>;
      };
      tokenSource?: string;
    }
  >;
}

/** Prefer cline-pass provider entry; fall back to cline (same WorkOS account). */
const PROVIDER_AUTH_KEYS = ["cline-pass", "cline"] as const;

const MODEL_CONFIGS = new Map<string, ClineModelConfig>([
  [
    "kimi-k3",
    {
      id: "kimi-k3",
      upstreamId: "cline-pass/kimi-k3",
      displayName: "ClinePass Kimi K3",
      contextWindow: 1_000_000,
      compactAtChars: 900_000,
      maxOutputTokens: 16_384,
      alwaysMaxReasoning: true,
    },
  ],
  [
    "kimi-k2.7-code",
    {
      id: "kimi-k2.7-code",
      upstreamId: "cline-pass/kimi-k2.7-code",
      displayName: "ClinePass Kimi K2.7 Code",
      contextWindow: 262_000,
      compactAtChars: 200_000,
      maxOutputTokens: 16_384,
    },
  ],
  [
    "kimi-k2.6",
    {
      id: "kimi-k2.6",
      upstreamId: "cline-pass/kimi-k2.6",
      displayName: "ClinePass Kimi K2.6",
      contextWindow: 262_000,
      compactAtChars: 200_000,
      maxOutputTokens: 16_384,
    },
  ],
  [
    "glm-5.2",
    {
      id: "glm-5.2",
      upstreamId: "cline-pass/glm-5.2",
      displayName: "ClinePass GLM-5.2",
      contextWindow: 200_000,
      compactAtChars: 160_000,
      maxOutputTokens: 16_384,
    },
  ],
  [
    "deepseek-v4-pro",
    {
      id: "deepseek-v4-pro",
      upstreamId: "cline-pass/deepseek-v4-pro",
      displayName: "ClinePass DeepSeek V4 Pro",
      contextWindow: 1_000_000,
      compactAtChars: 900_000,
      maxOutputTokens: 16_384,
    },
  ],
  [
    "deepseek-v4-flash",
    {
      id: "deepseek-v4-flash",
      upstreamId: "cline-pass/deepseek-v4-flash",
      displayName: "ClinePass DeepSeek V4 Flash",
      contextWindow: 1_000_000,
      compactAtChars: 900_000,
      maxOutputTokens: 16_384,
    },
  ],
  [
    "mimo-v2.5",
    {
      id: "mimo-v2.5",
      upstreamId: "cline-pass/mimo-v2.5",
      displayName: "ClinePass MiMo-V2.5",
      contextWindow: 262_000,
      compactAtChars: 200_000,
      maxOutputTokens: 16_384,
    },
  ],
  [
    "mimo-v2.5-pro",
    {
      id: "mimo-v2.5-pro",
      upstreamId: "cline-pass/mimo-v2.5-pro",
      displayName: "ClinePass MiMo-V2.5-Pro",
      contextWindow: 262_000,
      compactAtChars: 200_000,
      maxOutputTokens: 16_384,
    },
  ],
  [
    "minimax-m3",
    {
      id: "minimax-m3",
      upstreamId: "cline-pass/minimax-m3",
      displayName: "ClinePass MiniMax M3",
      contextWindow: 1_000_000,
      compactAtChars: 900_000,
      maxOutputTokens: 16_384,
    },
  ],
  [
    "qwen3.7-max",
    {
      id: "qwen3.7-max",
      upstreamId: "cline-pass/qwen3.7-max",
      displayName: "ClinePass Qwen3.7 Max",
      contextWindow: 262_000,
      compactAtChars: 200_000,
      maxOutputTokens: 16_384,
    },
  ],
  [
    "qwen3.7-plus",
    {
      id: "qwen3.7-plus",
      upstreamId: "cline-pass/qwen3.7-plus",
      displayName: "ClinePass Qwen3.7 Plus",
      contextWindow: 1_000_000,
      compactAtChars: 900_000,
      maxOutputTokens: 16_384,
    },
  ],
]);

const ALIASES = new Map<string, string>([
  ["cline-pass/kimi-k3", "kimi-k3"],
  ["moonshotai/kimi-k3", "kimi-k3"],
  ["k3", "kimi-k3"],
  ["cline-pass/kimi-k2.7-code", "kimi-k2.7-code"],
  ["cline-pass/kimi-k2.6", "kimi-k2.6"],
  ["cline-pass/glm-5.2", "glm-5.2"],
  ["cline-pass/deepseek-v4-pro", "deepseek-v4-pro"],
  ["cline-pass/deepseek-v4-flash", "deepseek-v4-flash"],
  ["cline-pass/mimo-v2.5", "mimo-v2.5"],
  ["cline-pass/mimo-v2.5-pro", "mimo-v2.5-pro"],
  ["cline-pass/minimax-m3", "minimax-m3"],
  ["cline-pass/qwen3.7-max", "qwen3.7-max"],
  ["cline-pass/qwen3.7-plus", "qwen3.7-plus"],
]);

export function clineModels(): ClineModelConfig[] {
  return [...MODEL_CONFIGS.values()];
}

export function isClineModel(model: string | undefined): boolean {
  if (!model) return false;
  // Require an explicit Cline/ClinePass prefix so bare IDs like deepseek-v4-pro
  // still route to other providers when unprefixed.
  if (!hasClinePrefix(model)) return false;
  return resolveClineModel(model) !== undefined;
}

export function resolveClineModel(model: string | undefined): ClineModelConfig | undefined {
  const id = normalizeClineModel(model ?? "");
  if (!id) return undefined;
  return MODEL_CONFIGS.get(ALIASES.get(id) ?? id);
}

function hasClinePrefix(model: string): boolean {
  const raw = model.trim();
  return /^(cline|clinepass|cline-pass)[/:]/i.test(raw) || raw.startsWith("cline-pass/");
}

export function defaultClineModel(): ClineModelConfig {
  return resolveClineModel(clineDefaultModel()) ?? MODEL_CONFIGS.get("kimi-k3")!;
}

export function clineRequestCharLimit(model: string | undefined): number {
  return (resolveClineModel(model) ?? defaultClineModel()).compactAtChars;
}

export async function fetchClineMessage(
  input: AnthropicMessageRequest,
  options: { signal?: AbortSignal } = {},
): Promise<AnthropicMessage> {
  const modelConfig = resolveClineModel(input.model) ?? defaultClineModel();
  const clientModel = input.model ?? `cline/${modelConfig.id}`;
  const completion = await fetchClineOpenAI(input, modelConfig, options);
  return openAIToAnthropic(completion, clientModel, estimateAnthropicInputTokens(input));
}

function normalizeClineModel(model: string): string {
  return model
    .trim()
    .replace(/\[1m\]$/i, "")
    .replace(/^cline[/:]/, "")
    .replace(/^clinepass[/:]/, "")
    .replace(/^cline-pass[/:]/, "");
}

async function fetchClineOpenAI(
  input: AnthropicMessageRequest,
  modelConfig: ClineModelConfig,
  options: { signal?: AbortSignal },
): Promise<OpenAIChatCompletion> {
  const authorization = await resolveAuthorization(options);
  const response = await fetch(clineChatCompletionsUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authorization,
      "X-Title": "ai-coding-proxy",
      "HTTP-Referer": "https://github.com/vacekj/ai-coding-proxy",
    },
    body: JSON.stringify(clineRequestBody(input, modelConfig)),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new ClineUpstreamError(
      response.status,
      `ClinePass upstream error ${response.status}: ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as unknown;
  return unwrapOpenAICompletion(payload);
}

function clineRequestBody(
  input: AnthropicMessageRequest,
  modelConfig: ClineModelConfig,
): OpenAIChatRequest {
  const body = anthropicToOpenAI(input, modelConfig);
  if (body.max_tokens == null) body.max_tokens = modelConfig.maxOutputTokens;

  // Kimi K3 only supports max reasoning; drop effort knobs that confuse routing.
  if (modelConfig.alwaysMaxReasoning) {
    delete body.effort;
    delete body.reasoning_effort;
  }

  return body;
}

function unwrapOpenAICompletion(payload: unknown): OpenAIChatCompletion {
  if (!isRecord(payload)) {
    throw new ClineUpstreamError(502, "ClinePass upstream returned a non-object response");
  }

  // OAuth account tokens wrap OpenAI payloads as { success, data }.
  // Static API keys may return the OpenAI object directly.
  const completion = isRecord(payload.data) && Array.isArray(payload.data.choices)
    ? payload.data
    : payload;

  if (!Array.isArray(completion.choices)) {
    throw new ClineUpstreamError(
      502,
      `ClinePass upstream response missing choices: ${JSON.stringify(payload).slice(0, 400)}`,
    );
  }

  return completion as OpenAIChatCompletion;
}

async function resolveAuthorization(options: { signal?: AbortSignal }): Promise<string> {
  const apiKey = clineApiKey();
  if (apiKey) return `Bearer ${apiKey}`;

  const token = await loadClineOAuthAccessToken(options);
  if (token) return `Bearer ${token}`;

  throw new ClineUpstreamError(
    401,
    "ClinePass auth required: set CLINE_API_KEY or sign in with `cline auth` (reads ~/.cline/data/settings/providers.json)",
  );
}

async function loadClineOAuthAccessToken(options: {
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const file = await readProvidersFile();
  if (!file) return undefined;

  const auth = pickOAuthAuth(file);
  if (!auth?.accessToken && !auth?.refreshToken) return undefined;

  if (auth.accessToken && !isExpired(auth.expiresAt)) {
    return withWorkosPrefix(auth.accessToken);
  }

  if (!auth.refreshToken) {
    if (auth.accessToken) return withWorkosPrefix(auth.accessToken);
    return undefined;
  }

  const refreshed = await refreshClineOAuth(auth.refreshToken, options);
  await persistRefreshedAuth(file, refreshed);
  return withWorkosPrefix(refreshed.accessToken);
}

function pickOAuthAuth(file: ClineProvidersFile): ClineOAuthAuth | undefined {
  for (const key of PROVIDER_AUTH_KEYS) {
    const auth = file.providers?.[key]?.settings?.auth;
    if (!auth) continue;
    if (typeof auth.accessToken === "string" || typeof auth.refreshToken === "string") {
      return {
        accessToken: typeof auth.accessToken === "string" ? auth.accessToken : "",
        refreshToken: typeof auth.refreshToken === "string" ? auth.refreshToken : "",
        expiresAt: auth.expiresAt,
        accountId: typeof auth.accountId === "string" ? auth.accountId : undefined,
      };
    }
  }
  return undefined;
}

async function refreshClineOAuth(
  refreshToken: string,
  options: { signal?: AbortSignal },
): Promise<{ accessToken: string; refreshToken: string; expiresAt?: number | string }> {
  const response = await fetch(clineRefreshUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      granttype: "refresh_token",
      refreshToken,
    }),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new ClineUpstreamError(
      response.status,
      `Cline OAuth refresh failed ${response.status}: ${await response.text()}`,
    );
  }

  const payload = (await response.json()) as unknown;
  const data = isRecord(payload) && isRecord(payload.data) ? payload.data : isRecord(payload) ? payload : null;
  if (!data || typeof data.accessToken !== "string") {
    throw new ClineUpstreamError(502, "Cline OAuth refresh response missing accessToken");
  }

  return {
    accessToken: data.accessToken,
    refreshToken: typeof data.refreshToken === "string" ? data.refreshToken : refreshToken,
    expiresAt: typeof data.expiresAt === "string" || typeof data.expiresAt === "number"
      ? data.expiresAt
      : undefined,
  };
}

async function readProvidersFile(): Promise<ClineProvidersFile | undefined> {
  const path = clineProvidersFilePath();
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    return (await file.json()) as ClineProvidersFile;
  } catch {
    throw new ClineUpstreamError(500, `Failed to parse Cline providers file at ${path}`);
  }
}

async function persistRefreshedAuth(
  file: ClineProvidersFile,
  refreshed: { accessToken: string; refreshToken: string; expiresAt?: number | string },
): Promise<void> {
  const accessToken = withWorkosPrefix(refreshed.accessToken);
  const expiresAt =
    typeof refreshed.expiresAt === "string"
      ? Date.parse(refreshed.expiresAt)
      : refreshed.expiresAt;

  if (!file.providers) file.providers = {};

  for (const key of PROVIDER_AUTH_KEYS) {
    const entry = file.providers[key];
    if (!entry?.settings?.auth) continue;
    entry.settings.auth.accessToken = accessToken;
    entry.settings.auth.refreshToken = refreshed.refreshToken;
    if (Number.isFinite(expiresAt)) entry.settings.auth.expiresAt = expiresAt;
  }

  await Bun.write(clineProvidersFilePath(), `${JSON.stringify(file, null, 2)}\n`);
}

function withWorkosPrefix(token: string): string {
  if (token.startsWith("workos:")) return token;
  // Account tokens from refresh are raw JWTs; the Cline gateway expects the workos: prefix.
  if (token.startsWith("eyJ")) return `workos:${token}`;
  return token;
}

function isExpired(expiresAt: number | string | undefined): boolean {
  if (expiresAt == null) return false;
  const ms = typeof expiresAt === "number" ? expiresAt : Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return false;
  // Refresh 60s early to avoid mid-request expiry.
  return Date.now() >= ms - 60_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
