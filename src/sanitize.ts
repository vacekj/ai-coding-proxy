import {
  compactedToolResultChars,
  maxRequestChars,
  maxToolResultChars,
} from "./config";
import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessageRequest,
} from "./types";

export interface SanitizeStats {
  truncatedToolResults: number;
  compactedToolResults: number;
  originalChars: number;
  sanitizedChars: number;
}

export interface SanitizedRequest {
  request: AnthropicMessageRequest;
  stats: SanitizeStats;
}

export function sanitizeAnthropicRequest(input: AnthropicMessageRequest): SanitizedRequest {
  const stats: SanitizeStats = {
    truncatedToolResults: 0,
    compactedToolResults: 0,
    originalChars: serializedLength(input),
    sanitizedChars: 0,
  };

  const request: AnthropicMessageRequest = {
    ...input,
    messages: (input.messages ?? []).map((message) =>
      sanitizeMessage(message, maxToolResultChars(), stats),
    ),
  };

  let nextLength = serializedLength(request);
  if (nextLength > maxRequestChars()) {
    compactOldToolResults(request, stats);
    nextLength = serializedLength(request);
  }

  stats.sanitizedChars = nextLength;
  return { request, stats };
}

function sanitizeMessage(
  message: AnthropicMessage,
  limit: number,
  stats: SanitizeStats,
): AnthropicMessage {
  if (typeof message.content === "string") return { ...message };

  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== "tool_result") return block;
      return sanitizeToolResult(block, limit, false, stats);
    }),
  };
}

function compactOldToolResults(request: AnthropicMessageRequest, stats: SanitizeStats): void {
  const messages = request.messages ?? [];

  for (const message of messages) {
    if (serializedLength(request) <= maxRequestChars()) return;
    if (typeof message.content === "string") continue;

    message.content = message.content.map((block) => {
      if (serializedLength(request) <= maxRequestChars()) return block;
      if (block.type !== "tool_result") return block;
      return sanitizeToolResult(block, compactedToolResultChars(), true, stats);
    });
  }
}

function sanitizeToolResult(
  block: AnthropicContentBlock,
  limit: number,
  compacted: boolean,
  stats: SanitizeStats,
): AnthropicContentBlock {
  if (block.type !== "tool_result") return block;
  const text = toolResultText(block.content);
  if (text.length <= limit) return block;

  if (compacted) stats.compactedToolResults += 1;
  else stats.truncatedToolResults += 1;

  return {
    ...block,
    content: truncateMiddle(
      text,
      limit,
      compacted
        ? "older tool result compacted by proxy"
        : "large tool result truncated by proxy",
    ),
  };
}

function toolResultText(content: unknown): string {
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

function truncateMiddle(text: string, limit: number, reason: string): string {
  const notice = `\n\n[${reason}: original ${text.length} chars, kept ${limit} chars with head/tail preserved]\n\n`;
  const bodyLimit = Math.max(0, limit - notice.length);
  if (bodyLimit <= 0) return notice.trim();

  const headChars = Math.ceil(bodyLimit * 0.65);
  const tailChars = Math.floor(bodyLimit * 0.35);
  return text.slice(0, headChars) + notice + text.slice(Math.max(headChars, text.length - tailChars));
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
