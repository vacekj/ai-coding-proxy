import {
  opencodeAnthropicBaseUrl,
  opencodeApiKey,
  opencodeDefaultModel,
  opencodeOpenAIBaseUrl,
} from "./config";
import type {
  AnthropicContentBlock,
  AnthropicImageSource,
  AnthropicMessageRequest,
  AnthropicTool,
  OpenAIChatCompletion,
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIChatToolCall,
} from "./types";
import {
  type AnthropicMessage,
  type AnthropicUsage,
  estimateAnthropicInputTokens,
  sanitizeClaudeToolID,
  toResponsesToolName,
} from "./translate";

export type OpenCodeProtocol = "openai" | "anthropic";

export interface OpenCodeModelConfig {
  id: string;
  upstreamId: string;
  protocol: OpenCodeProtocol;
  displayName: string;
  noMultimodal?: boolean;
}

export interface OpenAIChatModelConfig {
  id: string;
  upstreamId: string;
  noMultimodal?: boolean;
}

export class OpenCodeUpstreamError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpenCodeUpstreamError";
  }
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
  "nemotron-3-super-free",
  "nemotron-3-ultra-free",
];

const ANTHROPIC_MODELS = [
  "minimax-m3",
  "minimax-m3-free",
  "qwen3.7-max",
  "qwen3.6-plus",
  "qwen3.6-plus-free",
  "qwen3.5-plus",
];

const NO_MULTIMODAL = new Set(["glm-5.1", "glm-5"]);

const MODEL_CONFIGS = new Map<string, OpenCodeModelConfig>([
  ...OPENAI_MODELS.map((id) => [
    id,
    {
      id,
      upstreamId: upstreamModelId(id),
      protocol: "openai" as const,
      displayName: `OpenCode Zen ${id}`,
      noMultimodal: NO_MULTIMODAL.has(id),
    },
  ] as const),
  ...ANTHROPIC_MODELS.map((id) => [
    id,
    {
      id,
      upstreamId: upstreamModelId(id),
      protocol: "anthropic" as const,
      displayName: `OpenCode Zen ${id}`,
    },
  ] as const),
]);

export function openCodeModels(): OpenCodeModelConfig[] {
  return [...MODEL_CONFIGS.values()];
}

export function isOpenCodeModel(model: string | undefined): boolean {
  if (!model) return false;
  return resolveOpenCodeModel(model) !== undefined;
}

export function resolveOpenCodeModel(model: string | undefined): OpenCodeModelConfig | undefined {
  const id = normalizeOpenCodeModel(model ?? "");
  if (!id) return undefined;
  return MODEL_CONFIGS.get(id);
}

export function defaultOpenCodeModel(): OpenCodeModelConfig {
  return resolveOpenCodeModel(opencodeDefaultModel()) ?? MODEL_CONFIGS.get("minimax-m3-free")!;
}

export async function fetchOpenCodeMessage(
  input: AnthropicMessageRequest,
  options: { signal?: AbortSignal } = {},
): Promise<AnthropicMessage> {
  const modelConfig = resolveOpenCodeModel(input.model) ?? defaultOpenCodeModel();
  const clientModel = input.model ?? modelConfig.id;

  if (modelConfig.protocol === "anthropic") {
    const upstream = await fetchOpenCodeAnthropic(input, modelConfig, options);
    return normalizeAnthropicMessage(upstream, clientModel, estimateAnthropicInputTokens(input));
  }

  const completion = await fetchOpenCodeOpenAI(input, modelConfig, options);
  return openAIToAnthropic(completion, clientModel, estimateAnthropicInputTokens(input));
}

function normalizeOpenCodeModel(model: string): string {
  return model.trim().replace(/^opencode[/:]/, "");
}

function upstreamModelId(model: string): string {
  return model;
}

async function fetchOpenCodeAnthropic(
  input: AnthropicMessageRequest,
  modelConfig: OpenCodeModelConfig,
  options: { signal?: AbortSignal },
): Promise<unknown> {
  const body = {
    ...input,
    model: modelConfig.upstreamId,
    stream: false,
  };

  const response = await fetch(opencodeAnthropicBaseUrl(), {
    method: "POST",
    headers: opencodeHeaders("anthropic"),
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new OpenCodeUpstreamError(
      response.status,
      `OpenCode Zen Anthropic upstream error ${response.status}: ${await response.text()}`,
    );
  }

  return response.json();
}

async function fetchOpenCodeOpenAI(
  input: AnthropicMessageRequest,
  modelConfig: OpenCodeModelConfig,
  options: { signal?: AbortSignal },
): Promise<OpenAIChatCompletion> {
  const response = await fetch(opencodeOpenAIBaseUrl(), {
    method: "POST",
    headers: opencodeHeaders("openai"),
    body: JSON.stringify(anthropicToOpenAI(input, modelConfig)),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new OpenCodeUpstreamError(
      response.status,
      `OpenCode Zen OpenAI upstream error ${response.status}: ${await response.text()}`,
    );
  }

  return (await response.json()) as OpenAIChatCompletion;
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

export function anthropicToOpenAI(
  input: AnthropicMessageRequest,
  modelConfig: OpenAIChatModelConfig,
): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = [];
  const system = systemText(input.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of input.messages ?? []) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role === "assistant" ? "assistant" : "user", content: message.content });
      continue;
    }

    const role = message.role === "assistant" ? "assistant" : "user";
    const textParts: string[] = [];
    const contentParts: Array<Record<string, unknown>> = [];
    const toolCalls: OpenAIChatToolCall[] = [];
    const toolResultMessages: OpenAIChatMessage[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case "text": {
          const text = typeof block.text === "string" ? block.text : "";
          textParts.push(text);
          contentParts.push({ type: "text", text });
          break;
        }
        case "image": {
          const imageUrl = anthropicImageToURL(block);
          if (imageUrl && !modelConfig.noMultimodal) {
            contentParts.push({ type: "image_url", image_url: { url: imageUrl } });
          }
          break;
        }
        case "thinking": {
          if (typeof block.thinking === "string") textParts.push(block.thinking);
          break;
        }
        case "tool_use": {
          if (role !== "assistant") break;
          toolCalls.push({
            id: typeof block.id === "string" && block.id ? block.id : makeToolId(),
            type: "function",
            function: {
              name: toResponsesToolName(typeof block.name === "string" ? block.name : "tool"),
              arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
            },
          });
          break;
        }
        case "tool_result": {
          toolResultMessages.push({
            role: "tool",
            tool_call_id: typeof block.tool_use_id === "string" ? block.tool_use_id : "",
            content: extractText(block.content),
          });
          break;
        }
      }
    }

    messages.push(...toolResultMessages);
    if (toolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: textParts.join("\n") || null,
        tool_calls: toolCalls,
      });
      continue;
    }

    if (contentParts.length > 1 && !modelConfig.noMultimodal) {
      messages.push({ role, content: contentParts });
      continue;
    }

    if (textParts.length > 0 || contentParts.length > 0) {
      messages.push({ role, content: textParts.join("\n") });
    }
  }

  const body: OpenAIChatRequest = {
    model: modelConfig.upstreamId,
    messages,
    max_tokens: input.max_tokens ?? 16_384,
    stream: false,
  };

  if (input.temperature != null) body.temperature = input.temperature;
  if (input.top_p != null) body.top_p = input.top_p;
  if (input.stop_sequences?.length) body.stop = input.stop_sequences;

  const effort = effortFromAnthropic(input, modelConfig);
  if (effort) {
    if (isDeepSeekV4(modelConfig)) body.reasoning_effort = effort;
    else body.effort = effort;
  }
  if (input.thinking?.budget_tokens) body.max_completion_tokens = input.thinking.budget_tokens;

  if (input.tools?.length) {
    body.tools = input.tools.map(openAITool);
    body.tool_choice = openAIToolChoice(input.tool_choice);
  }

  return body;
}

function openAITool(tool: AnthropicTool): NonNullable<OpenAIChatRequest["tools"]>[number] {
  return {
    type: "function",
    function: {
      name: toResponsesToolName(tool.name),
      description: tool.description ?? "",
      parameters: isRecord(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
    },
  };
}

function openAIToolChoice(choice: AnthropicMessageRequest["tool_choice"]): unknown {
  if (!choice) return "auto";
  if (choice === "any") return "required";
  if (typeof choice === "string") return choice;
  if (choice.type === "any") return "required";
  if (choice.type === "none") return "none";
  if (choice.type === "tool") {
    return { type: "function", function: { name: toResponsesToolName(choice.name ?? "") } };
  }
  return "auto";
}

export function openAIToAnthropic(
  completion: OpenAIChatCompletion,
  clientModel: string,
  estimatedInputTokens: number,
): AnthropicMessage {
  const choice = completion.choices?.[0];
  const message = choice?.message ?? {};
  const content: AnthropicContentBlock[] = [];

  const reasoning = message.reasoning_content ?? message.reasoning;
  if (typeof reasoning === "string" && reasoning) {
    content.push({ type: "thinking", thinking: reasoning });
  }

  if (typeof message.content === "string" && message.content) {
    content.push({ type: "text", text: message.content });
  } else if (Array.isArray(message.content)) {
    const text = message.content
      .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
      .join("");
    if (text) content.push({ type: "text", text });
  }

  for (const call of message.tool_calls ?? []) {
    content.push({
      type: "tool_use",
      id: sanitizeClaudeToolID(call.id ?? makeToolId()),
      name: call.function?.name ?? "tool",
      input: parseToolArguments(call.function?.arguments),
    });
  }

  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: completion.id?.startsWith("msg_") ? completion.id : `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: clientModel,
    content,
    stop_reason: mapOpenAIStopReason(choice?.finish_reason, content.some((block) => block.type === "tool_use")),
    stop_sequence: null,
    usage: openAIUsage(completion, estimatedInputTokens),
  };
}

function normalizeAnthropicMessage(
  upstream: unknown,
  clientModel: string,
  estimatedInputTokens: number,
): AnthropicMessage {
  if (!isRecord(upstream)) {
    throw new Error("OpenCode Zen Anthropic upstream returned a non-object response");
  }

  const content = Array.isArray(upstream.content)
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
      input_tokens: numberValue(usage.input_tokens, estimatedInputTokens),
      output_tokens: numberValue(usage.output_tokens, 0),
      cache_read_input_tokens: numberValue(usage.cache_read_input_tokens, 0),
    },
  };
}

function openAIUsage(completion: OpenAIChatCompletion, estimatedInputTokens: number): AnthropicUsage {
  const usage = completion.usage ?? {};
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (usage.prompt_tokens ?? estimatedInputTokens) - cached),
    output_tokens: (usage.completion_tokens ?? 0) + (usage.completion_tokens_details?.reasoning_tokens ?? 0),
    cache_read_input_tokens: cached,
  };
}

function mapOpenAIStopReason(reason: string | null | undefined, hasToolCall: boolean): string {
  if (hasToolCall) return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "content_filter") return "content_filter";
  return "end_turn";
}

function systemText(system: AnthropicMessageRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system.trim();
  return system
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

function anthropicImageToURL(block: AnthropicContentBlock): string | undefined {
  if (block.type !== "image" || !block.source) return undefined;
  const source = block.source as AnthropicImageSource;
  if (source.type === "url" && source.url) return source.url;
  if (source.data) return `data:${source.media_type ?? "application/octet-stream"};base64,${source.data}`;
  return undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.text === "string") return item.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function effortFromAnthropic(
  input: AnthropicMessageRequest,
  modelConfig: OpenAIChatModelConfig,
): string | undefined {
  if (isDeepSeekV4(modelConfig)) return deepSeekV4EffortFromAnthropic(input);

  const explicit = input.output_config?.effort?.toLowerCase();
  if (explicit) return clampGenericEffort(explicit);

  const thinking = input.thinking;
  if (!thinking || thinking.type === "disabled") return undefined;
  if (thinking.type === "adaptive" || thinking.type === "auto") return "high";
  const budget = thinking.budget_tokens ?? 0;
  if (budget >= 24_000) return "high";
  if (budget >= 8_000) return "medium";
  return "low";
}

function deepSeekV4EffortFromAnthropic(input: AnthropicMessageRequest): string | undefined {
  const explicit = input.output_config?.effort?.toLowerCase();
  if (explicit) return clampDeepSeekV4Effort(explicit);

  const thinking = input.thinking;
  if (!thinking) return undefined;
  if (thinking.type === "disabled") return "none";
  if (thinking.type === "max" || thinking.type === "xhigh") return "max";
  if ((thinking.budget_tokens ?? 0) >= 24_000) return "max";
  return "high";
}

function clampDeepSeekV4Effort(value: string): string {
  if (value === "none" || value === "minimal") return "none";
  if (value === "max" || value === "xhigh") return "max";
  if (value === "low" || value === "medium" || value === "high" || value === "adaptive" || value === "auto") {
    return "high";
  }
  return "high";
}

function clampGenericEffort(value: string): string {
  if (value === "none" || value === "minimal") return "low";
  if (value === "xhigh" || value === "max") return "high";
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

function isDeepSeekV4(modelConfig: OpenAIChatModelConfig): boolean {
  return modelConfig.id.includes("deepseek-v4-") || modelConfig.upstreamId.includes("deepseek-v4-");
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function makeToolId(): string {
  return `toolu_${crypto.randomUUID().replaceAll("-", "")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
