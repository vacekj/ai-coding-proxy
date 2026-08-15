import { upstreamModel } from "./config";
import {
  anthropicImageToDataURL,
  clampEffort,
  isRecord,
  makeToolId,
  parseToolArguments,
  sanitizeClaudeToolID,
  systemText,
  toResponsesToolName,
} from "./util";
import type {
  AnthropicContentBlock,
  AnthropicMessageRequest,
  AnthropicTool,
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesRequest,
  ResponsesTool,
  ResponsesToolChoice,
  XAIOutputItem,
  XAIResponse,
} from "./types";

export interface TranslationResult {
  request: ResponsesRequest;
  clientModel: string;
  upstreamModel: string;
  toolNameMap: Map<string, string>;
  reverseToolNameMap: Map<string, string>;
}

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
}

export function anthropicToResponses(input: AnthropicMessageRequest): TranslationResult {
  const model = upstreamModel();
  const toolNameMap = buildToolNameMap(input.tools ?? []);
  const reverseToolNameMap = new Map([...toolNameMap.entries()].map(([original, short]) => [short, original]));

  const request: ResponsesRequest = {
    model,
    input: [],
    stream: true,
    store: false,
    parallel_tool_calls: !toolChoiceDisablesParallel(input.tool_choice),
  };

  if (input.max_tokens != null) request.max_output_tokens = input.max_tokens;
  if (input.temperature != null) request.temperature = input.temperature;
  if (input.top_p != null) request.top_p = input.top_p;
  if (input.stop_sequences?.length) request.stop = input.stop_sequences;

  const effort = supportsReasoningEffort(model) ? reasoningEffort(input) : undefined;
  if (effort) {
    request.reasoning = { effort, summary: "auto" };
  }

  const instructions = systemText(input.system);
  request.instructions = [
    "Only answer the current request transcript. Ignore any unrelated active-session, cached, or tool context not present in this request.",
    "The client owns local tool execution. Use only tools listed in this request. If no tools are listed, answer without tool calls.",
    instructions,
  ]
    .filter(Boolean)
    .join("\n\n");

  for (const message of input.messages ?? []) {
    const role = message.role === "assistant" ? "assistant" : "user";
    if (typeof message.content === "string") {
      appendMessage(request.input, role, [
        {
          type: role === "assistant" ? "output_text" : "input_text",
          text: message.content,
        },
      ]);
      continue;
    }

    let pendingParts: ResponsesContentPart[] = [];
    const flushMessage = () => {
      if (pendingParts.length === 0) return;
      appendMessage(request.input, role, pendingParts);
      pendingParts = [];
    };

    for (const part of message.content) {
      switch (part.type) {
        case "text": {
          pendingParts.push({
            type: role === "assistant" ? "output_text" : "input_text",
            text: String(part.text ?? ""),
          });
          break;
        }
        case "image": {
          const imageURL = anthropicImageToDataURL(part);
          if (imageURL) {
            pendingParts.push({ type: "input_image", image_url: imageURL });
          }
          break;
        }
        case "thinking": {
          if (role === "assistant" && typeof part.signature === "string" && part.signature) {
            flushMessage();
            request.input.push({
              type: "reasoning",
              encrypted_content: part.signature,
              summary: [],
              content: null,
            });
          }
          break;
        }
        case "tool_use": {
          if (role !== "assistant") break;
          flushMessage();
          const originalName = String(part.name ?? "");
          request.input.push({
            type: "function_call",
            call_id: String(part.id ?? makeToolId()),
            name: toolNameMap.get(originalName) ?? toResponsesToolName(originalName),
            arguments: JSON.stringify(isRecord(part.input) ? part.input : {}),
          });
          break;
        }
        case "tool_result": {
          flushMessage();
          request.input.push({
            type: "function_call_output",
            call_id: String(part.tool_use_id ?? ""),
            output: toolResultOutput(part.content),
          });
          break;
        }
        default: {
          const unknown = part as { text?: unknown };
          if (typeof unknown.text === "string") {
            pendingParts.push({
              type: role === "assistant" ? "output_text" : "input_text",
              text: unknown.text,
            });
          }
        }
      }
    }
    flushMessage();
  }

  const tools = convertTools(input.tools ?? [], toolNameMap);
  if (tools.length > 0) {
    request.tools = tools;
    request.tool_choice = convertToolChoice(input.tool_choice, toolNameMap);
  }

  return {
    request,
    clientModel: input.model ?? model,
    upstreamModel: model,
    toolNameMap,
    reverseToolNameMap,
  };
}

export function responseToAnthropicMessage(
  response: XAIResponse,
  clientModel: string,
  reverseToolNameMap = new Map<string, string>(),
): AnthropicMessage {
  const content: AnthropicContentBlock[] = [];
  let hasTool = false;

  for (const item of response.output ?? []) {
    switch (item.type) {
      case "reasoning": {
        const thinking = reasoningText(item);
        const signature = typeof item.encrypted_content === "string" ? item.encrypted_content : undefined;
        if (thinking || signature) {
          content.push({
            type: "thinking",
            thinking,
            signature,
          });
        }
        break;
      }
      case "message": {
        for (const text of messageTexts(item)) {
          content.push({ type: "text", text });
        }
        break;
      }
      case "function_call": {
        hasTool = true;
        content.push({
          type: "tool_use",
          id: sanitizeClaudeToolID(String(item.call_id ?? item.id ?? makeToolId())),
          name: reverseToolNameMap.get(String(item.name ?? "")) ?? String(item.name ?? ""),
          input: parseToolArguments(item.arguments),
        });
        break;
      }
    }
  }

  return {
    id: response.id ?? `msg_${crypto.randomUUID().replaceAll("-", "")}`,
    type: "message",
    role: "assistant",
    model: clientModel,
    content,
    stop_reason: mapStopReason(response, hasTool),
    stop_sequence: typeof response.stop_sequence === "string" ? response.stop_sequence : null,
    usage: responseUsage(response),
  };
}

export function responseUsage(response: XAIResponse): AnthropicUsage {
  const usage = response.usage ?? {};
  const cached = usage.input_tokens_details?.cached_tokens ?? 0;
  const rawInput = usage.input_tokens ?? 0;
  const input = Math.max(0, rawInput - cached);
  const out: AnthropicUsage = {
    input_tokens: input,
    output_tokens: usage.output_tokens ?? 0,
  };
  if (cached > 0) out.cache_read_input_tokens = cached;
  return out;
}

export function mapStopReason(response: XAIResponse, hasToolCall: boolean): string {
  if (hasToolCall) return "tool_use";
  const reason =
    response.stop_reason ??
    response.incomplete_details?.reason ??
    (response.stop_sequence ? "stop_sequence" : "stop");
  switch (reason) {
    case "max_tokens":
    case "max_output_tokens":
      return "max_tokens";
    case "tool_use":
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "stop_sequence":
    case "pause_turn":
    case "refusal":
    case "model_context_window_exceeded":
      return reason;
    case "content_filter":
      return "refusal";
    default:
      return "end_turn";
  }
}

export function estimateAnthropicInputTokens(request: AnthropicMessageRequest): number {
  const text = JSON.stringify({
    system: request.system,
    messages: request.messages,
    tools: request.tools,
  });
  return Math.max(1, Math.ceil(text.length / 4));
}

function appendMessage(
  input: ResponsesInputItem[],
  role: "user" | "assistant",
  content: ResponsesContentPart[],
): void {
  if (content.length === 0) return;
  input.push({ type: "message", role, content });
}

function toolResultOutput(content: unknown): string | ResponsesContentPart[] {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: ResponsesContentPart[] = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      if (item.type === "text" && typeof item.text === "string") {
        parts.push({ type: "input_text", text: item.text });
      } else if (item.type === "image") {
        const imageURL = anthropicImageToDataURL(item as AnthropicContentBlock);
        if (imageURL) parts.push({ type: "input_image", image_url: imageURL });
      }
    }
    return parts.length > 0 ? parts : JSON.stringify(content);
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

function convertTools(tools: AnthropicTool[], nameMap: Map<string, string>): ResponsesTool[] {
  const out: ResponsesTool[] = [];
  for (const tool of tools) {
    if (typeof tool.type === "string" && tool.type.startsWith("web_search")) {
      out.push({
        type: "web_search",
        name: nameMap.get(tool.name) ?? toResponsesToolName(tool.name),
      });
      continue;
    }
    out.push({
      type: "function",
      name: nameMap.get(tool.name) ?? toResponsesToolName(tool.name),
      description: tool.description,
      parameters: normalizeSchema(tool.input_schema),
      strict: false,
    });
  }
  return out;
}

function convertToolChoice(
  choice: AnthropicMessageRequest["tool_choice"],
  nameMap: Map<string, string>,
): ResponsesToolChoice {
  if (!choice) return "auto";
  if (typeof choice === "string") {
    if (choice === "any") return "required";
    return choice;
  }
  switch (choice.type) {
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return { type: "function", name: nameMap.get(choice.name ?? "") ?? toResponsesToolName(choice.name ?? "") };
    default:
      return "auto";
  }
}

function toolChoiceDisablesParallel(choice: AnthropicMessageRequest["tool_choice"]): boolean {
  return isRecord(choice) && choice.disable_parallel_tool_use === true;
}

function reasoningEffort(input: AnthropicMessageRequest): string | undefined {
  const explicit = input.output_config?.effort?.toLowerCase();
  if (explicit) return clampEffort(explicit);

  const thinking = input.thinking;
  if (!thinking || thinking.type === "disabled") return undefined;
  if (thinking.type === "adaptive" || thinking.type === "auto") return "high";
  const budget = thinking.budget_tokens ?? 0;
  if (budget >= 24_000) return "high";
  if (budget >= 8_000) return "medium";
  return "low";
}

function normalizeSchema(schema: unknown): Record<string, unknown> {
  if (!isRecord(schema)) return { type: "object", properties: {} };
  const out = { ...schema };
  if (typeof out.type !== "string") out.type = "object";
  if (out.type === "object" && !isRecord(out.properties)) out.properties = {};
  return out;
}

function buildToolNameMap(tools: AnthropicTool[]): Map<string, string> {
  const map = new Map<string, string>();
  const used = new Set<string>();
  for (const tool of tools) {
    let name = toResponsesToolName(preferredGrokToolName(tool.name, used));
    const base = name;
    let index = 2;
    while (used.has(name)) {
      name = toResponsesToolName(`${base}_${index}`);
      index++;
    }
    used.add(name);
    map.set(tool.name, name);
  }
  return map;
}

function preferredGrokToolName(name: string, used: Set<string>): string {
  const aliases: Record<string, string> = {
    Bash: "Shell",
  };
  const alias = aliases[name];
  if (alias && !used.has(alias)) return alias;
  return name;
}

function supportsReasoningEffort(model: string): boolean {
  const name = model.toLowerCase().split("/").at(-1) ?? model.toLowerCase();
  return (
    name.startsWith("grok-3-mini") ||
    name.startsWith("grok-4.20-multi-agent") ||
    name.startsWith("grok-4.3")
  );
}

function messageTexts(item: XAIOutputItem): string[] {
  if (item.type !== "message") return [];
  if (typeof item.content === "string") return item.content ? [item.content] : [];
  if (!Array.isArray(item.content)) return [];
  const out: string[] = [];
  for (const part of item.content) {
    if (part.type === "output_text" || part.type === "text") {
      if (typeof part.text === "string" && part.text) out.push(part.text);
    }
  }
  return out;
}

function reasoningText(item: XAIOutputItem): string {
  if (item.type !== "reasoning") return "";
  const parts: string[] = [];
  collectText(item.summary, parts);
  collectText(item.content, parts);
  return parts.join("");
}

function collectText(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return;
  }
  if (isRecord(value)) {
    if (typeof value.text === "string") out.push(value.text);
    else if (typeof value.summary_text === "string") out.push(value.summary_text);
  }
}
