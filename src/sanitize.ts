import {
  compactedToolResultChars,
  maxRequestChars,
  maxToolResultChars,
} from "./config";
import { toolResultText } from "./util";
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

export interface SanitizeOptions {
  maxRequestChars?: number;
}

const HEAD_RATIO = 0.65;
const TAIL_RATIO = 0.35;

export function sanitizeAnthropicRequest(
  input: AnthropicMessageRequest,
  options: SanitizeOptions = {},
): SanitizedRequest {
  const requestCharLimit = options.maxRequestChars ?? maxRequestChars();
  const stats: SanitizeStats = {
    truncatedToolResults: 0,
    compactedToolResults: 0,
    originalChars: serializedLength(input),
    sanitizedChars: 0,
  };

  const truncated = new Set<AnthropicContentBlock>();
  const messages = (input.messages ?? []).map((message) =>
    sanitizeMessage(message, maxToolResultChars(), stats, truncated),
  );
  const request: AnthropicMessageRequest = { ...input, messages };

  let nextLength = serializedLength(request);
  if (nextLength > requestCharLimit) {
    nextLength = compactOldToolResults(request, requestCharLimit, stats, truncated, nextLength);
  }

  stats.sanitizedChars = nextLength;
  return { request, stats };
}

function sanitizeMessage(
  message: AnthropicMessage,
  limit: number,
  stats: SanitizeStats,
  truncated: Set<AnthropicContentBlock>,
): AnthropicMessage {
  if (typeof message.content === "string") return { ...message };

  return {
    ...message,
    content: message.content.map((block) => {
      if (block.type !== "tool_result") return block;
      const next = clampToolResult(block, limit, "large tool result truncated by proxy", stats, true);
      if (next !== block) truncated.add(next);
      return next;
    }),
  };
}

function compactOldToolResults(
  request: AnthropicMessageRequest,
  requestCharLimit: number,
  stats: SanitizeStats,
  truncated: Set<AnthropicContentBlock>,
  startLength: number,
): number {
  let length = startLength;

  for (const message of request.messages ?? []) {
    if (length <= requestCharLimit) break;
    if (typeof message.content === "string") continue;

    for (let i = 0; i < message.content.length; i++) {
      if (length <= requestCharLimit) break;
      const block = message.content[i];
      if (block.type !== "tool_result" || truncated.has(block)) continue;

      const next = clampToolResult(block, compactedToolResultChars(), "older tool result compacted by proxy", stats, false);
      if (next === block) continue;
      message.content[i] = next;
      length += serializedLength(next) - serializedLength(block);
    }
  }

  return length;
}

function clampToolResult(
  block: AnthropicContentBlock,
  limit: number,
  notice: string,
  stats: SanitizeStats,
  countAsTruncated: boolean,
): AnthropicContentBlock {
  if (block.type !== "tool_result") return block;
  const text = toolResultText(block.content);
  if (text.length <= limit) return block;

  if (countAsTruncated) stats.truncatedToolResults += 1;
  else stats.compactedToolResults += 1;

  return {
    ...block,
    content: truncateMiddle(text, limit, notice),
  };
}

function truncateMiddle(text: string, limit: number, reason: string): string {
  const notice = `\n\n[${reason}: original ${text.length} chars, kept ${limit} chars with head/tail preserved]\n\n`;
  const bodyLimit = Math.max(0, limit - notice.length);
  if (bodyLimit <= 0) return notice.trim();

  const headChars = Math.ceil(bodyLimit * HEAD_RATIO);
  const tailChars = Math.floor(bodyLimit * TAIL_RATIO);
  return text.slice(0, headChars) + notice + text.slice(Math.max(headChars, text.length - tailChars));
}

function serializedLength(value: unknown): number {
  return JSON.stringify(value).length;
}
