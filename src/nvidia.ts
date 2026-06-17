import {
  nvidiaApiKey,
  nvidiaChatCompletionsUrl,
  nvidiaDefaultModel,
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

export interface NvidiaModelConfig extends OpenAIChatModelConfig {
  displayName: string;
  contextWindow: number;
  compactAtChars: number;
  maxOutputTokens: number;
  deepSeekV4Thinking?: boolean;
}

export class NvidiaUpstreamError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "NvidiaUpstreamError";
  }
}

const MODEL_CONFIGS = new Map<string, NvidiaModelConfig>([
  [
    "deepseek-v4-pro",
    {
      id: "deepseek-v4-pro",
      upstreamId: "deepseek-ai/deepseek-v4-pro",
      displayName: "NVIDIA DeepSeek V4 Pro",
      contextWindow: 1_000_000,
      compactAtChars: 900_000,
      maxOutputTokens: 16_384,
      deepSeekV4Thinking: true,
    },
  ],
  [
    "deepseek-v4-flash",
    {
      id: "deepseek-v4-flash",
      upstreamId: "deepseek-ai/deepseek-v4-flash",
      displayName: "NVIDIA DeepSeek V4 Flash",
      contextWindow: 1_000_000,
      compactAtChars: 900_000,
      maxOutputTokens: 16_384,
      deepSeekV4Thinking: true,
    },
  ],
  [
    "kimi-k2.6",
    {
      id: "kimi-k2.6",
      upstreamId: "moonshotai/kimi-k2.6",
      displayName: "NVIDIA Kimi K2.6",
      contextWindow: 256_000,
      compactAtChars: 200_000,
      maxOutputTokens: 16_384,
    },
  ],
]);

const ALIASES = new Map<string, string>([
  ["deepseek-ai/deepseek-v4-pro", "deepseek-v4-pro"],
  ["dsv4-pro", "deepseek-v4-pro"],
  ["dsv4", "deepseek-v4-pro"],
  ["deepseek-ai/deepseek-v4-flash", "deepseek-v4-flash"],
  ["dsv4-flash", "deepseek-v4-flash"],
  ["moonshotai/kimi-k2.6", "kimi-k2.6"],
]);

export function nvidiaModels(): NvidiaModelConfig[] {
  return [...MODEL_CONFIGS.values()];
}

export function isNvidiaModel(model: string | undefined): boolean {
  if (!model) return false;
  return resolveNvidiaModel(model) !== undefined;
}

export function resolveNvidiaModel(model: string | undefined): NvidiaModelConfig | undefined {
  const id = normalizeNvidiaModel(model ?? "");
  if (!id) return undefined;
  return MODEL_CONFIGS.get(ALIASES.get(id) ?? id);
}

export function defaultNvidiaModel(): NvidiaModelConfig {
  return resolveNvidiaModel(nvidiaDefaultModel()) ?? MODEL_CONFIGS.get("deepseek-v4-pro")!;
}

export function nvidiaRequestCharLimit(model: string | undefined): number {
  return (resolveNvidiaModel(model) ?? defaultNvidiaModel()).compactAtChars;
}

export async function fetchNvidiaMessage(
  input: AnthropicMessageRequest,
  options: { signal?: AbortSignal } = {},
): Promise<AnthropicMessage> {
  const modelConfig = resolveNvidiaModel(input.model) ?? defaultNvidiaModel();
  const clientModel = input.model ?? `nvidia/${modelConfig.id}`;
  const completion = await fetchNvidiaOpenAI(input, modelConfig, options);
  return openAIToAnthropic(completion, clientModel, estimateAnthropicInputTokens(input));
}

function normalizeNvidiaModel(model: string): string {
  return model.trim().replace(/\[1m\]$/i, "").replace(/^nvidia[/:]/, "");
}

async function fetchNvidiaOpenAI(
  input: AnthropicMessageRequest,
  modelConfig: NvidiaModelConfig,
  options: { signal?: AbortSignal },
): Promise<OpenAIChatCompletion> {
  const response = await fetch(nvidiaChatCompletionsUrl(), {
    method: "POST",
    headers: nvidiaHeaders(),
    body: JSON.stringify(nvidiaRequestBody(input, modelConfig)),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new NvidiaUpstreamError(
      response.status,
      `NVIDIA NIM upstream error ${response.status}: ${await response.text()}`,
    );
  }

  return (await response.json()) as OpenAIChatCompletion;
}

function nvidiaRequestBody(
  input: AnthropicMessageRequest,
  modelConfig: NvidiaModelConfig,
): OpenAIChatRequest {
  const body = anthropicToOpenAI(input, modelConfig);
  if (body.temperature == null) body.temperature = 1;
  if (body.top_p == null) body.top_p = 0.95;
  if (body.max_tokens == null) body.max_tokens = modelConfig.maxOutputTokens;

  if (modelConfig.deepSeekV4Thinking) {
    const reasoningEffort = typeof body.reasoning_effort === "string" ? body.reasoning_effort : "max";
    delete body.reasoning_effort;
    body.chat_template_kwargs = {
      thinking: reasoningEffort !== "none",
      reasoning_effort: reasoningEffort,
    };
  }

  return body;
}

function nvidiaHeaders(): Record<string, string> {
  const key = nvidiaApiKey();
  if (!key) {
    throw new NvidiaUpstreamError(
      401,
      "NVIDIA_API_KEY is required for NVIDIA NIM models",
    );
  }

  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${key}`,
  };
}
