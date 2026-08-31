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

export type GlmFlashProvider = "openrouter" | "hermes";

export interface GlmFlashModelConfig extends OpenAIChatModelConfig {
  provider: GlmFlashProvider;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
}

const UPSTREAM_ID = "z-ai/glm-5.3-flash";
const MODEL_SLUG = "glm-5.3-flash";

const MODEL_CONFIGS: GlmFlashModelConfig[] = [
  glmFlashModel("openrouter", "OpenRouter GLM-5.3-Flash"),
  glmFlashModel("hermes", "Nous Portal GLM-5.3-Flash"),
];

function glmFlashModel(provider: GlmFlashProvider, displayName: string): GlmFlashModelConfig {
  return {
    id: `${provider}/${MODEL_SLUG}`,
    upstreamId: UPSTREAM_ID,
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
  const match =
    /^(openrouter|hermes|nous)[/:](?:(?:stealth\/)?ox-alpha|(?:z-ai\/)?glm-5\.3-flash)$/i.exec(raw);
  if (!match) return undefined;
  const provider = match[1]!.toLowerCase() === "openrouter" ? "openrouter" : "hermes";
  return `${provider}/${MODEL_SLUG}`;
}

const registry = createModelRegistry(MODEL_CONFIGS, normalizeModelId);

export function glmFlashModels(): GlmFlashModelConfig[] {
  return registry.models();
}

export function resolveGlmFlashModel(model: string | undefined): GlmFlashModelConfig | undefined {
  return registry.resolve(model);
}

export function defaultGlmFlashModel(provider: GlmFlashProvider): GlmFlashModelConfig {
  return registry.resolve(`${provider}/${MODEL_SLUG}`)!;
}

export async function fetchGlmFlashMessage(
  input: AnthropicMessageRequest,
  provider: GlmFlashProvider,
  options: { signal?: AbortSignal } = {},
): Promise<AnthropicMessage> {
  const modelConfig = resolveGlmFlashModel(input.model) ?? defaultGlmFlashModel(provider);
  const clientModel = input.model ?? modelConfig.id;
  const upstream = await fetchGlmFlashResponse(input, modelConfig, {
    signal: options.signal,
    stream: false,
  });
  return openAIToAnthropic(
    (await upstream.json()) as OpenAIChatCompletion,
    clientModel,
    estimateAnthropicInputTokens(input),
  );
}

export function streamGlmFlashMessage(
  input: AnthropicMessageRequest,
  provider: GlmFlashProvider,
  options: { signal?: AbortSignal } = {},
): ReadableStream<Uint8Array> {
  const modelConfig = resolveGlmFlashModel(input.model) ?? defaultGlmFlashModel(provider);
  const clientModel = input.model ?? modelConfig.id;
  const controller = new AbortController();
  const signal = anySignal(options.signal, controller.signal);
  const upstream = fetchGlmFlashResponse(input, modelConfig, { signal, stream: true });

  return openAIChatStreamToAnthropicSSE(
    upstream,
    clientModel,
    estimateAnthropicInputTokens(input),
    { signal: controller.signal, abort: () => controller.abort() },
  );
}

async function fetchGlmFlashResponse(
  input: AnthropicMessageRequest,
  modelConfig: GlmFlashModelConfig,
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

function upstream(provider: GlmFlashProvider): {
  url: string;
  headers: Record<string, string>;
  label: string;
} {
  if (provider === "openrouter") {
    const key = openRouterApiKey();
    if (!key) {
      throw new Error(
        "No OPENROUTER_API_KEY configured for openrouter/glm-5.3-flash. " +
          "Create a key at https://openrouter.ai/keys and export it.",
      );
    }
    return {
      url: openRouterOpenAIBaseUrl(),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      label: "OpenRouter GLM-5.3-Flash",
    };
  }

  const key = nousApiKey();
  if (!key) {
    throw new Error(
      "No NOUS_API_KEY configured for hermes/glm-5.3-flash. " +
        "Create a key in the Nous Portal at https://portal.nousresearch.com and export it.",
    );
  }
  return {
    url: nousOpenAIBaseUrl(),
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    label: "Nous Portal GLM-5.3-Flash",
  };
}
