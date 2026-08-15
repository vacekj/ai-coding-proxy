import {
  opencodeAnthropicBaseUrl,
  opencodeApiKey,
  opencodeDefaultModel,
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

export interface OpenCodeModelConfig extends OpenAIChatModelConfig {
  protocol: OpenCodeProtocol;
  displayName: string;
}

const OPENAI_MODELS = [
  "glm-5.1",
  "glm-5",
  "kimi-k2.5",
  "kimi-k2.6",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4-flash-free",
  "big-pickle",
  "minimax-m2.7",
  "minimax-m2.5",
  "mimo-v2.5-free",
  "nemotron-3-ultra-free",
  "north-mini-code-free",
];

const ANTHROPIC_MODELS = [
  "minimax-m3",
  "qwen3.7-max",
  "qwen3.6-plus",
  "qwen3.6-plus-free",
  "qwen3.5-plus",
];

const NO_MULTIMODAL = new Set(["glm-5.1", "glm-5"]);

const registry: ModelRegistry<OpenCodeModelConfig> = createModelRegistry(
  [
    ...OPENAI_MODELS.map((id) => ({
      id,
      upstreamId: id,
      protocol: "openai" as const,
      displayName: `OpenCode Zen ${id}`,
      noMultimodal: NO_MULTIMODAL.has(id),
    })),
    ...ANTHROPIC_MODELS.map((id) => ({
      id,
      upstreamId: id,
      protocol: "anthropic" as const,
      displayName: `OpenCode Zen ${id}`,
    })),
  ],
  (model) => {
    const id = model.trim().replace(/^opencode[/:]/, "");
    return id || undefined;
  },
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
  return registry.defaultModel(opencodeDefaultModel(), "mimo-v2.5-free");
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

  if (modelConfig.protocol === "anthropic") {
    const upstream = fetchOpenCodeResponse(input, modelConfig, { signal, stream: true });
    return anthropicSSEToAnthropicSSE(upstream, clientModel, {
      signal: controller.signal,
      abort: () => controller.abort(),
    });
  }

  const upstream = fetchOpenCodeResponse(input, modelConfig, { signal, stream: true });
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
  if (modelConfig.protocol === "anthropic") {
    return postJSON(
      opencodeAnthropicBaseUrl(),
      opencodeHeaders("anthropic"),
      { ...input, model: modelConfig.upstreamId, stream: options.stream },
      options.signal,
      "OpenCode Zen",
    );
  }

  return postJSON(
    opencodeOpenAIBaseUrl(),
    opencodeHeaders("openai"),
    anthropicToOpenAI(input, modelConfig, { stream: options.stream }),
    options.signal,
    "OpenCode Zen",
  );
}

function opencodeHeaders(protocol: OpenCodeProtocol): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  const key = opencodeApiKey();
  if (key && protocol === "openai") headers.Authorization = `Bearer ${key}`;
  if (key && protocol === "anthropic") headers["x-api-key"] = key;
  if (protocol === "anthropic") headers["anthropic-version"] = "2023-06-01";
  return headers;
}

function normalizeAnthropicMessage(
  upstream: unknown,
  clientModel: string,
  input: AnthropicMessageRequest,
): AnthropicMessage {
  if (!isRecord(upstream)) {
    throw new Error("OpenCode Zen Anthropic upstream returned a non-object response");
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
