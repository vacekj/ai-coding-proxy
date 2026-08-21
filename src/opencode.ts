import { readFile } from "node:fs/promises";
import {
  opencodeAnthropicBaseUrl,
  opencodeApiKey,
  opencodeAuthFilePath,
  opencodeDefaultModel,
  opencodeGoAnthropicBaseUrl,
  opencodeGoOpenAIBaseUrl,
  opencodeOpenAIBaseUrl,
} from "./config";
import { createModelRegistry, type ModelRegistry } from "./model-registry";
import {
  anthropicToOpenAI,
  openAIChatStreamToAnthropicSSE,
  openAIToAnthropic,
  type OpenAIChatModelConfig,
} from "./openai-compat";
import { anySignal, anthropicSSEToAnthropicSSE, postJSON } from "./passthrough";
import { isRecord, numberValue } from "./util";
import { estimateAnthropicInputTokens, type AnthropicMessage } from "./translate";
import type { AnthropicContentBlock, AnthropicMessageRequest, OpenAIChatCompletion } from "./types";

export type OpenCodeProtocol = "openai" | "anthropic";
/** Zen is the pay-as-you-go/free catalog; Go is the subscription catalog. */
export type OpenCodePlan = "zen" | "go";

export interface OpenCodeModelConfig extends OpenAIChatModelConfig {
  plan: OpenCodePlan;
  protocol: OpenCodeProtocol;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
}

interface ModelSpec {
  id: string;
  context: number;
  output: number;
  /** Defaults to "openai"; "anthropic" uses the upstream's native /messages passthrough. */
  protocol?: OpenCodeProtocol;
  /** Defaults to false. Claude Code sends screenshots, so this has to be accurate. */
  multimodal?: boolean;
}

/**
 * Zen's $0 tier. These answer without any Authorization header, which is why the
 * proxy can serve them with no credentials at all. Every paid Zen model was dropped:
 * they need a Zen credit balance that an OpenCode Go subscription does not provide.
 */
const ZEN_MODELS: ModelSpec[] = [
  { id: "big-pickle", context: 200_000, output: 32_000 },
  { id: "hy3-free", context: 190_000, output: 64_000 },
  { id: "laguna-s-2.1-free", context: 256_000, output: 32_000 },
  { id: "mimo-v2.5-free", context: 200_000, output: 32_000, multimodal: true },
  { id: "muse-spark-1.2-contributor-free", context: 1_048_576, output: 131_072, multimodal: true },
  { id: "nemotron-3-ultra-free", context: 1_000_000, output: 128_000 },
  { id: "nemotron-3.5-lightning-free", context: 262_144, output: 262_144 },
  { id: "x-preview-f-free", context: 1_000_000, output: 131_072, multimodal: true },
];

/**
 * OpenCode Go, authenticated with the `opencode-go` key from the OpenCode CLI's auth store.
 * `deepseek-v4-pro` and `deepseek-v4-flash` are omitted: they return RegionError until
 * China hosting is opted into per-workspace. `deepseek-v4-flash-vision-exp` needs no opt-in.
 */
const GO_MODELS: ModelSpec[] = [
  { id: "deepseek-v4-flash-vision-exp", context: 1_000_000, output: 384_000, multimodal: true },
  { id: "glm-5", context: 202_752, output: 32_768 },
  { id: "glm-5.1", context: 202_752, output: 32_768 },
  { id: "glm-5.2", context: 1_000_000, output: 131_072 },
  { id: "glm-5.3", context: 1_000_000, output: 131_072 },
  { id: "gpt-5.6-luna", context: 1_050_000, output: 128_000, multimodal: true },
  { id: "hy3", context: 256_000, output: 64_000 },
  { id: "kimi-k2.5", context: 262_144, output: 65_536, multimodal: true },
  { id: "kimi-k2.6", context: 262_144, output: 65_536, multimodal: true },
  { id: "kimi-k2.7-code", context: 262_144, output: 262_144, multimodal: true },
  { id: "kimi-k3", context: 1_048_576, output: 131_072, protocol: "anthropic", multimodal: true },
  { id: "mimo-v2.5", context: 1_000_000, output: 128_000, multimodal: true },
  { id: "mimo-v2.5-pro", context: 1_048_576, output: 128_000 },
  { id: "minimax-m2.5", context: 204_800, output: 65_536, protocol: "anthropic" },
  { id: "minimax-m2.7", context: 204_800, output: 131_072, protocol: "anthropic" },
  { id: "minimax-m3", context: 1_000_000, output: 131_072, protocol: "anthropic", multimodal: true },
  { id: "muse-spark-1.2-contributor", context: 1_048_576, output: 131_072, multimodal: true },
  { id: "ox-alpha-free", context: 1_000_000, output: 131_072, multimodal: true },
  { id: "qwen3.5-plus", context: 262_144, output: 65_536, protocol: "anthropic", multimodal: true },
  { id: "qwen3.6-plus", context: 1_000_000, output: 65_536, protocol: "anthropic", multimodal: true },
  { id: "qwen3.7-max", context: 1_000_000, output: 65_536, protocol: "anthropic" },
  { id: "qwen3.7-plus", context: 1_000_000, output: 65_536, protocol: "anthropic", multimodal: true },
  { id: "qwen3.8-max", context: 1_000_000, output: 131_072, protocol: "anthropic", multimodal: true },
];

const PLAN_LABELS: Record<OpenCodePlan, string> = {
  zen: "OpenCode Zen",
  go: "OpenCode Go",
};

function toModelConfig(spec: ModelSpec, plan: OpenCodePlan): OpenCodeModelConfig {
  return {
    id: `${plan}/${spec.id}`,
    upstreamId: spec.id,
    plan,
    protocol: spec.protocol ?? "openai",
    displayName: `${PLAN_LABELS[plan]} ${spec.id}`,
    noMultimodal: spec.multimodal !== true,
    contextWindow: spec.context,
    maxOutputTokens: spec.output,
  };
}

const MODEL_CONFIGS: OpenCodeModelConfig[] = [
  ...ZEN_MODELS.map((spec) => toModelConfig(spec, "zen")),
  ...GO_MODELS.map((spec) => toModelConfig(spec, "go")),
];

const KNOWN_IDS = new Set(MODEL_CONFIGS.map((config) => config.id));

/**
 * Accepts `zen/<id>`, `go/<id>`, the legacy `opencode/<id>` alias, and bare `<id>`.
 * Zen and Go share ids, so a bare id prefers Zen and falls back to Go.
 */
function normalizeModelId(model: string): string | undefined {
  const raw = model
    .trim()
    .replace(/\[1m\]$/i, "")
    .trim();
  if (!raw) return undefined;

  const prefixed = /^(zen|go|opencode)[/:](.+)$/i.exec(raw);
  if (prefixed) {
    const plan = prefixed[1]!.toLowerCase() === "go" ? "go" : "zen";
    return `${plan}/${prefixed[2]!.trim()}`;
  }

  if (KNOWN_IDS.has(`zen/${raw}`)) return `zen/${raw}`;
  if (KNOWN_IDS.has(`go/${raw}`)) return `go/${raw}`;
  return undefined;
}

const registry: ModelRegistry<OpenCodeModelConfig> = createModelRegistry(
  MODEL_CONFIGS,
  normalizeModelId,
);

export function opencodeModels(): OpenCodeModelConfig[] {
  return registry.models();
}

export function isOpenCodeModel(model: string | undefined): boolean {
  return model != null && registry.resolve(model) !== undefined;
}

export function resolveOpenCodeModel(model: string | undefined): OpenCodeModelConfig | undefined {
  return registry.resolve(model);
}

export function defaultOpenCodeModel(): OpenCodeModelConfig {
  return registry.defaultModel(opencodeDefaultModel(), "zen/mimo-v2.5-free");
}

export async function fetchOpenCodeMessage(
  input: AnthropicMessageRequest,
  options: { signal?: AbortSignal } = {},
): Promise<AnthropicMessage> {
  const modelConfig = resolveOpenCodeModel(input.model) ?? defaultOpenCodeModel();
  const clientModel = input.model ?? modelConfig.id;
  const upstream = await fetchOpenCodeResponse(input, modelConfig, { signal: options.signal, stream: false });
  const payload = (await upstream.json()) as unknown;

  if (modelConfig.protocol === "anthropic") {
    return normalizeAnthropicMessage(payload, clientModel, input);
  }

  return openAIToAnthropic(payload as OpenAIChatCompletion, clientModel, estimateAnthropicInputTokens(input));
}

export function streamOpenCodeMessage(
  input: AnthropicMessageRequest,
  options: { signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const modelConfig = resolveOpenCodeModel(input.model) ?? defaultOpenCodeModel();
  const clientModel = input.model ?? modelConfig.id;
  const controller = new AbortController();
  const signal = anySignal(options.signal, controller.signal);
  const upstream = fetchOpenCodeResponse(input, modelConfig, { signal, stream: true });

  if (modelConfig.protocol === "anthropic") {
    return anthropicSSEToAnthropicSSE(upstream, clientModel, {
      signal: controller.signal,
      abort: () => controller.abort(),
    });
  }

  return openAIChatStreamToAnthropicSSE(upstream, clientModel, estimateAnthropicInputTokens(input), {
    signal: controller.signal,
    abort: () => controller.abort(),
  });
}

async function fetchOpenCodeResponse(
  input: AnthropicMessageRequest,
  modelConfig: OpenCodeModelConfig,
  options: { signal?: AbortSignal; stream: boolean },
): Promise<Response> {
  const headers = await opencodeHeaders(modelConfig);
  const label = PLAN_LABELS[modelConfig.plan];

  if (modelConfig.protocol === "anthropic") {
    return postJSON(
      anthropicUrl(modelConfig),
      headers,
      { ...input, model: modelConfig.upstreamId, stream: options.stream },
      options.signal,
      label,
    );
  }

  return postJSON(
    openAIUrl(modelConfig),
    headers,
    anthropicToOpenAI(input, modelConfig, { stream: options.stream }),
    options.signal,
    label,
  );
}

function openAIUrl(modelConfig: OpenCodeModelConfig): string {
  return modelConfig.plan === "go" ? opencodeGoOpenAIBaseUrl() : opencodeOpenAIBaseUrl();
}

function anthropicUrl(modelConfig: OpenCodeModelConfig): string {
  return modelConfig.plan === "go" ? opencodeGoAnthropicBaseUrl() : opencodeAnthropicBaseUrl();
}

async function opencodeHeaders(modelConfig: OpenCodeModelConfig): Promise<Record<string, string>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (modelConfig.protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";

  const key = modelConfig.plan === "go" ? await opencodeGoApiKey() : opencodeApiKey();
  if (key) {
    if (modelConfig.protocol === "anthropic") headers["x-api-key"] = key;
    else headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

let cachedGoApiKey: string | undefined;

/**
 * Reads the Go subscription key the OpenCode CLI already stores, mirroring how the
 * Grok provider reuses ~/.grok/auth.json. The proxy never takes a key from its clients.
 */
export async function opencodeGoApiKey(): Promise<string> {
  if (cachedGoApiKey) return cachedGoApiKey;

  const path = opencodeAuthFilePath();
  const hint = `Run "opencode auth login" and choose OpenCode Go, then retry.`;

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`No OpenCode credentials file at ${path}. ${hint}`);
  }

  const entry = isRecord(parsed) ? parsed["opencode-go"] : undefined;
  const key = isRecord(entry) && typeof entry.key === "string" ? entry.key.trim() : "";
  if (!key) {
    throw new Error(`No "opencode-go" API key in ${path}. ${hint}`);
  }

  cachedGoApiKey = key;
  return key;
}

function normalizeAnthropicMessage(
  upstream: unknown,
  clientModel: string,
  input: AnthropicMessageRequest,
): AnthropicMessage {
  if (!isRecord(upstream)) {
    throw new Error("OpenCode Anthropic upstream returned a non-object response");
  }

  const content: AnthropicContentBlock[] = Array.isArray(upstream.content)
    ? (upstream.content as AnthropicContentBlock[])
    : [{ type: "text", text: typeof upstream.content === "string" ? upstream.content : "" }];
  const usage = isRecord(upstream.usage) ? upstream.usage : {};

  return {
    id: typeof upstream.id === "string" ? upstream.id : `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: clientModel,
    content,
    stop_reason: typeof upstream.stop_reason === "string" ? upstream.stop_reason : "end_turn",
    stop_sequence: typeof upstream.stop_sequence === "string" ? upstream.stop_sequence : null,
    usage: {
      input_tokens: numberValue(usage.input_tokens, estimateAnthropicInputTokens(input)),
      output_tokens: numberValue(usage.output_tokens, 0),
      cache_read_input_tokens: numberValue(usage.cache_read_input_tokens, 0),
    },
  };
}
