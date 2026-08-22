import {
  nousApiKey,
  nousOpenAIBaseUrl,
  openRouterApiKey,
  openRouterOpenAIBaseUrl,
} from "./config";
import { createModelRegistry } from "./model-registry";
import {
  anthropicToOpenAI,
  openAIChatStreamToAnthropicSSE,
  openAIToAnthropic,
  type OpenAIChatModelConfig,
} from "./openai-compat";
import { anySignal, postJSON } from "./passthrough";
import { estimateAnthropicInputTokens, type AnthropicMessage } from "./translate";
import type { AnthropicMessageRequest, OpenAIChatCompletion } from "./types";

export type OxAlphaProvider = "openrouter" | "hermes";

export interface OxAlphaModelConfig extends OpenAIChatModelConfig {
  provider: OxAlphaProvider;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
}

const MODEL_CONFIGS: OxAlphaModelConfig[] = [
  oxAlphaModel("openrouter", "OpenRouter Ox Alpha"),
  oxAlphaModel("hermes", "Nous Portal Ox Alpha"),
];

function oxAlphaModel(provider: OxAlphaProvider, displayName: string): OxAlphaModelConfig {
  return {
    id: `${provider}/ox-alpha`,
    upstreamId: "stealth/ox-alpha",
    provider,
    displayName,
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
    reasoningParameter: "reasoning",
    supportedReasoningEfforts: ["max", "high", "low"],
    preserveReasoning: true,
  };
}

function normalizeModelId(model: string): string | undefined {
  const raw = model.trim().replace(/\[1m\]$/i, "").trim();
  const match = /^(openrouter|hermes|nous)[/:](?:stealth\/)?ox-alpha$/i.exec(raw);
  if (!match) return undefined;
  const provider = match[1]!.toLowerCase() === "openrouter" ? "openrouter" : "hermes";
  return `${provider}/ox-alpha`;
}

const registry = createModelRegistry(MODEL_CONFIGS, normalizeModelId);

export function oxAlphaModels(): OxAlphaModelConfig[] {
  return registry.models();
}

export function resolveOxAlphaModel(model: string | undefined): OxAlphaModelConfig | undefined {
  return registry.resolve(model);
}

export function defaultOxAlphaModel(provider: OxAlphaProvider): OxAlphaModelConfig {
  return registry.resolve(`${provider}/ox-alpha`)!;
}

export async function fetchOxAlphaMessage(
  input: AnthropicMessageRequest,
  provider: OxAlphaProvider,
  options: { signal?: AbortSignal } = {},
): Promise<AnthropicMessage> {
  const modelConfig = resolveOxAlphaModel(input.model) ?? defaultOxAlphaModel(provider);
  const clientModel = input.model ?? modelConfig.id;
  const upstream = await fetchOxAlphaResponse(input, modelConfig, {
    signal: options.signal,
    stream: false,
  });
  return openAIToAnthropic(
    (await upstream.json()) as OpenAIChatCompletion,
    clientModel,
    estimateAnthropicInputTokens(input),
  );
}

export function streamOxAlphaMessage(
  input: AnthropicMessageRequest,
  provider: OxAlphaProvider,
  options: { signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const modelConfig = resolveOxAlphaModel(input.model) ?? defaultOxAlphaModel(provider);
  const clientModel = input.model ?? modelConfig.id;
  const controller = new AbortController();
  const signal = anySignal(options.signal, controller.signal);
  const upstream = fetchOxAlphaResponse(input, modelConfig, { signal, stream: true });

  return openAIChatStreamToAnthropicSSE(
    upstream,
    clientModel,
    estimateAnthropicInputTokens(input),
    { signal: controller.signal, abort: () => controller.abort() },
  );
}

async function fetchOxAlphaResponse(
  input: AnthropicMessageRequest,
  modelConfig: OxAlphaModelConfig,
  options: { signal?: AbortSignal; stream: boolean },
): Promise<Response> {
  const { url, headers, label } = upstream(modelConfig.provider);
  return postJSON(
    url,
    headers,
    anthropicToOpenAI(input, modelConfig, { stream: options.stream }),
    options.signal,
    label,
  );
}

function upstream(provider: OxAlphaProvider): {
  url: string;
  headers: Record<string, string>;
  label: string;
} {
  if (provider === "openrouter") {
    const key = openRouterApiKey();
    if (!key) {
      throw new Error(
        "No OPENROUTER_API_KEY configured for openrouter/ox-alpha. " +
          "Create a key at https://openrouter.ai/keys and export it.",
      );
    }
    return {
      url: openRouterOpenAIBaseUrl(),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      label: "OpenRouter Ox Alpha",
    };
  }

  const key = nousApiKey();
  if (!key) {
    throw new Error(
      "No NOUS_API_KEY configured for hermes/ox-alpha. " +
        "Create a key in the Nous Portal at https://portal.nousresearch.com and export it.",
    );
  }
  return {
    url: nousOpenAIBaseUrl(),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    label: "Nous Portal Ox Alpha",
  };
}
