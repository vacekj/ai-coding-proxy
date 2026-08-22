import { streamPingMs } from "./config";
import { encodeSSE, parseSSE } from "./sse";
import {
  anthropicImageToDataURL,
  clampEffort,
  isRecord,
  makeToolId,
  parseToolArguments,
  sanitizeClaudeToolID,
  systemText,
  toResponsesToolName,
  toolResultText,
} from "./util";
import type {
  AnthropicContentBlock,
  AnthropicMessageRequest,
  AnthropicTool,
  OpenAIChatCompletion,
  OpenAIChatMessage,
  OpenAIChatRequest,
  OpenAIChatToolCall,
  OpenAIToolChoice,
} from "./types";
import type { AnthropicMessage, AnthropicUsage } from "./translate";

export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
const HIGH_REASONING_BUDGET = 24_000;
const MEDIUM_REASONING_BUDGET = 8_000;

export interface OpenAIChatModelConfig {
  id: string;
  upstreamId: string;
  noMultimodal?: boolean;
  /** Upstream output limit; used to default and clamp max_tokens. */
  maxOutputTokens?: number;
  /** How this OpenAI-compatible upstream accepts reasoning effort. */
  reasoningParameter?: "effort" | "reasoning_effort" | "reasoning";
  /** Restrict effort values for models whose reasoning cannot be disabled. */
  supportedReasoningEfforts?: readonly string[];
  /** Preserve assistant thinking when continuing a tool-call conversation. */
  preserveReasoning?: boolean;
}

export function anthropicToOpenAI(
  input: AnthropicMessageRequest,
  modelConfig: OpenAIChatModelConfig,
  options: { defaultMaxTokens?: number; stream?: boolean } = {},
): OpenAIChatRequest {
  const messages: OpenAIChatMessage[] = [];
  const system = systemText(input.system);
  if (system) messages.push({ role: "system", content: system });

  for (const message of input.messages ?? []) {
    if (typeof message.content === "string") {
      messages.push({ role: message.role, content: message.content });
      continue;
    }

    const role = message.role;
    const textParts: string[] = [];
    const contentParts: Array<Record<string, unknown>> = [];
    const toolCalls: OpenAIChatToolCall[] = [];
    const toolResultMessages: OpenAIChatMessage[] = [];
    let reasoningContent = "";

    for (const block of message.content) {
      switch (block.type) {
        case "text": {
          const text = typeof block.text === "string" ? block.text : "";
          textParts.push(text);
          contentParts.push({ type: "text", text });
          break;
        }
        case "image": {
          const imageUrl = anthropicImageToDataURL(block);
          if (imageUrl && !modelConfig.noMultimodal) {
            contentParts.push({ type: "image_url", image_url: { url: imageUrl } });
          }
          break;
        }
        case "thinking": {
          if (role === "assistant" && (isDeepSeekV4(modelConfig) || modelConfig.preserveReasoning)) {
            if (typeof block.thinking === "string") reasoningContent = block.thinking;
          }
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
            content: toolResultText(block.content),
          });
          break;
        }
      }
    }

    messages.push(...toolResultMessages);
    if (toolCalls.length > 0) {
      const assistant: OpenAIChatMessage = {
        role: "assistant",
        content: textParts.join("\n") || null,
        tool_calls: toolCalls,
      };
      if (reasoningContent) assistant.reasoning_content = reasoningContent;
      messages.push(assistant);
      continue;
    }

    if (contentParts.length > 1 && !modelConfig.noMultimodal) {
      messages.push({ role, content: contentParts });
      continue;
    }

    if (textParts.length > 0 || contentParts.length > 0) {
      const assistant: OpenAIChatMessage = { role, content: textParts.join("\n") };
      if (role === "assistant" && reasoningContent) assistant.reasoning_content = reasoningContent;
      messages.push(assistant);
    }
  }

  const maxOutput = modelConfig.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  const requestedMaxTokens = input.max_tokens ?? options.defaultMaxTokens ?? maxOutput;
  const body: OpenAIChatRequest = {
    model: modelConfig.upstreamId,
    messages,
    max_tokens: Math.min(requestedMaxTokens, maxOutput),
    stream: options.stream ?? false,
  };

  if (input.temperature != null) body.temperature = input.temperature;
  if (input.top_p != null) body.top_p = input.top_p;
  if (input.stop_sequences?.length) body.stop = input.stop_sequences;

  const effort = effortFromAnthropic(input, modelConfig);
  if (effort) {
    const parameter =
      modelConfig.reasoningParameter ??
      (isDeepSeekV4(modelConfig) ? "reasoning_effort" : "effort");
    if (parameter === "reasoning") body.reasoning = { effort };
    else if (parameter === "reasoning_effort") body.reasoning_effort = effort;
    else body.effort = effort;
  }

  if (input.tools?.length) {
    body.tools = input.tools.map(openAITool);
    body.tool_choice = openAIToolChoice(input.tool_choice);
  }

  return body;
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

export function mapOpenAIStopReason(reason: string | null | undefined, hasToolCall: boolean): string {
  if (hasToolCall) return "tool_use";
  if (reason === "length") return "max_tokens";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "content_filter") return "content_filter";
  return "end_turn";
}

export function openAIUsage(completion: OpenAIChatCompletion, estimatedInputTokens: number): AnthropicUsage {
  const usage = completion.usage ?? {};
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    input_tokens: Math.max(0, (usage.prompt_tokens ?? estimatedInputTokens) - cached),
    output_tokens: (usage.completion_tokens ?? 0) + (usage.completion_tokens_details?.reasoning_tokens ?? 0),
    cache_read_input_tokens: cached,
  };
}

export function effortFromAnthropic(
  input: AnthropicMessageRequest,
  modelConfig: OpenAIChatModelConfig,
): string | undefined {
  if (isDeepSeekV4(modelConfig)) return deepSeekV4EffortFromAnthropic(input);

  const explicit = input.output_config?.effort?.toLowerCase();
  if (explicit) return modelEffort(explicit, modelConfig);

  const thinking = input.thinking;
  if (!thinking) return undefined;
  if (thinking.type === "disabled") {
    return modelConfig.supportedReasoningEfforts?.length ? modelEffort("low", modelConfig) : undefined;
  }
  if (thinking.type === "adaptive" || thinking.type === "auto") return modelEffort("high", modelConfig);
  const budget = thinking.budget_tokens ?? 0;
  if (budget >= HIGH_REASONING_BUDGET) return modelEffort("high", modelConfig);
  if (budget >= MEDIUM_REASONING_BUDGET) return modelEffort("medium", modelConfig);
  return modelEffort("low", modelConfig);
}

function modelEffort(value: string, modelConfig: OpenAIChatModelConfig): string {
  const supported = modelConfig.supportedReasoningEfforts;
  if (!supported?.length) return clampEffort(value);

  const normalized =
    value === "xhigh" ? "max" : value === "minimal" || value === "none" ? "low" : value;
  if (supported.includes(normalized)) return normalized;
  if ((normalized === "max" || normalized === "medium") && supported.includes("high")) return "high";
  if (supported.includes("low")) return "low";
  return supported[0];
}

export function deepSeekV4EffortFromAnthropic(input: AnthropicMessageRequest): string | undefined {
  const explicit = input.output_config?.effort?.toLowerCase();
  if (explicit) return clampDeepSeekV4Effort(explicit);

  const thinking = input.thinking;
  if (!thinking) return undefined;
  if (thinking.type === "disabled") return "none";
  if (thinking.type === "max" || thinking.type === "xhigh") return "max";
  if ((thinking.budget_tokens ?? 0) >= HIGH_REASONING_BUDGET) return "max";
  return "high";
}

function clampDeepSeekV4Effort(value: string): string {
  if (value === "none" || value === "minimal") return "none";
  if (value === "max" || value === "xhigh") return "max";
  return "high";
}

export function isDeepSeekV4(modelConfig: OpenAIChatModelConfig): boolean {
  return modelConfig.id.includes("deepseek-v4-") || modelConfig.upstreamId.includes("deepseek-v4-");
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

function openAIToolChoice(choice: AnthropicMessageRequest["tool_choice"]): OpenAIToolChoice {
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

export interface OpenAIChunk {
  id?: string;
  object?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    completion_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

interface ToolBlockState {
  anthropicIndex: number;
  id: string;
  name: string;
}

interface StreamRelayOptions {
  signal?: AbortSignal;
  abort?: () => void;
}

export function openAIChatStreamToAnthropicSSE(
  upstreamPromise: Promise<Response>,
  clientModel: string,
  estimatedInputTokens: number,
  options: StreamRelayOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let pingInterval: ReturnType<typeof setInterval> | undefined;
  let done = false;

  const clearPings = () => {
    if (pingInterval !== undefined) {
      clearInterval(pingInterval);
      pingInterval = undefined;
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (done) return;
        try {
          controller.enqueue(encoder.encode(encodeSSE(event, data)));
        } catch {
          finish();
        }
      };
      const finish = () => {
        done = true;
        clearPings();
        options.abort?.();
        try {
          controller.close();
        } catch {
          // Stream already closed (consumer disconnected or cancelled).
        }
      };

      pingInterval = setInterval(() => send("ping", { type: "ping" }), streamPingMs());

      let response: Response;
      try {
        response = await upstreamPromise;
      } catch (error) {
        send("error", errorPayload(error));
        finish();
        return;
      }

      const body = response.body;
      if (!body) {
        send("error", { type: "error", error: { type: "api_error", message: "upstream returned an empty body" } });
        finish();
        return;
      }

      send("message_start", {
        type: "message_start",
        message: {
          id: `msg_${crypto.randomUUID().replaceAll("-", "")}`,
          type: "message",
          role: "assistant",
          model: clientModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: estimatedInputTokens,
            cache_read_input_tokens: 0,
            output_tokens: 0,
          },
        },
      });

      const openToolBlocks = new Map<number, ToolBlockState>();
      const closedBlocks = new Set<number>();
      let nextBlockIndex = 0;
      let textBlockIndex: number | undefined;
      let thinkingBlockIndex: number | undefined;
      let finishReason: string | null | undefined;
      let outputTokens = 0;
      let hasToolCall = false;

      const emitBlockStart = (block: { type: "text"; text: string } | { type: "thinking"; thinking: string } | {
        type: "tool_use";
        id: string;
        name: string;
        input: Record<string, unknown>;
      }): number => {
        const index = nextBlockIndex++;
        send("content_block_start", {
          type: "content_block_start",
          index,
          content_block: block,
        });
        return index;
      };

      const emitBlockStop = (index: number) => {
        if (closedBlocks.has(index)) return;
        closedBlocks.add(index);
        send("content_block_stop", { type: "content_block_stop", index });
      };

      try {
        for await (const message of parseSSE(body, options.signal)) {
          if (message.data === "[DONE]") break;
          let chunk: OpenAIChunk;
          try {
            chunk = JSON.parse(message.data) as OpenAIChunk;
          } catch {
            continue;
          }
          const choice = chunk.choices?.[0];
          if (!choice) {
            if (chunk.usage?.completion_tokens != null) {
              outputTokens = chunk.usage.completion_tokens + (chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0);
            }
            continue;
          }
          const delta = choice.delta ?? {};
          if (chunk.usage?.completion_tokens != null) {
            outputTokens = chunk.usage.completion_tokens + (chunk.usage.completion_tokens_details?.reasoning_tokens ?? 0);
          }

          if (typeof delta.content === "string" && delta.content) {
            if (textBlockIndex === undefined) {
              textBlockIndex = emitBlockStart({ type: "text", text: "" });
            }
            send("content_block_delta", {
              type: "content_block_delta",
              index: textBlockIndex,
              delta: { type: "text_delta", text: delta.content },
            });
          }

          const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoningDelta === "string" && reasoningDelta) {
            if (thinkingBlockIndex === undefined) {
              thinkingBlockIndex = emitBlockStart({ type: "thinking", thinking: "" });
            }
            send("content_block_delta", {
              type: "content_block_delta",
              index: thinkingBlockIndex,
              delta: { type: "thinking_delta", thinking: reasoningDelta },
            });
          }

          for (const toolCall of delta.tool_calls ?? []) {
            if (toolCall.index == null) continue;
            hasToolCall = true;
            let state = openToolBlocks.get(toolCall.index);
            if (!state) {
              const id = toolCall.id ?? "";
              const name = toolCall.function?.name ?? "";
              if (!id && !name && !toolCall.function?.arguments) continue;
              state = {
                anthropicIndex: emitBlockStart({
                  type: "tool_use",
                  id: id || makeToolId(),
                  name: name || "tool",
                  input: {},
                }),
                id,
                name,
              };
              openToolBlocks.set(toolCall.index, state);
            } else if (toolCall.id && !state.id) {
              state.id = toolCall.id;
            }
            if (typeof toolCall.function?.arguments === "string" && toolCall.function.arguments) {
              send("content_block_delta", {
                type: "content_block_delta",
                index: state.anthropicIndex,
                delta: { type: "input_json_delta", partial_json: toolCall.function.arguments },
              });
            }
          }

          if (choice.finish_reason) {
            finishReason = choice.finish_reason;
            break;
          }
        }
      } catch (error) {
        send("error", errorPayload(error));
        finish();
        return;
      }

      for (const block of openToolBlocks.values()) emitBlockStop(block.anthropicIndex);
      if (textBlockIndex !== undefined) emitBlockStop(textBlockIndex);
      if (thinkingBlockIndex !== undefined) emitBlockStop(thinkingBlockIndex);

      send("message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: mapOpenAIStopReason(finishReason, hasToolCall),
          stop_sequence: null,
        },
        usage: { output_tokens: outputTokens },
      });
      send("message_stop", { type: "message_stop" });
      finish();
    },
    cancel() {
      done = true;
      clearPings();
      options.abort?.();
    },
  });
}

export function errorPayload(error: unknown): {
  type: "error";
  error: { type: "api_error"; message: string };
} {
  return {
    type: "error",
    error: {
      type: "api_error",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
