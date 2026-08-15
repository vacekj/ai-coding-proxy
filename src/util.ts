import type { AnthropicContentBlock, AnthropicImageSource, AnthropicMessageRequest } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function makeToolId(): string {
  return `toolu_${crypto.randomUUID().replaceAll("-", "")}`;
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function systemText(system: AnthropicMessageRequest["system"]): string {
  if (!system) return "";
  if (typeof system === "string") return system.trim();
  return system
    .map((block) => (block.type === "text" && typeof block.text === "string" ? block.text.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}

export function anthropicImageToDataURL(block: AnthropicContentBlock): string | undefined {
  if (block.type !== "image" || !block.source) return undefined;
  const source = block.source as AnthropicImageSource;
  if (source.type === "url" && source.url) return source.url;
  if (source.data) return `data:${source.media_type ?? "application/octet-stream"};base64,${source.data}`;
  return undefined;
}

export function toolResultText(content: unknown): string {
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

export function clampEffort(value: string): string {
  if (value === "none" || value === "minimal") return "low";
  if (value === "xhigh" || value === "max") return "high";
  if (value === "low" || value === "medium" || value === "high") return value;
  return "medium";
}

const TOOL_NAME_MAX_LENGTH = 64;

export function toResponsesToolName(name: string): string {
  const cleaned = (name || "tool").replace(/[^a-zA-Z0-9_-]/g, "_");
  if (cleaned.length <= TOOL_NAME_MAX_LENGTH) return cleaned || "tool";
  const suffix = `_${hashCode(cleaned).toString(36)}`;
  return cleaned.slice(0, Math.max(1, TOOL_NAME_MAX_LENGTH - suffix.length)) + suffix;
}

export function sanitizeClaudeToolID(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return cleaned || makeToolId();
}

export function nearExpiry(expiresAtMs: number | undefined, leadMs: number): boolean {
  if (expiresAtMs == null) return false;
  return Date.now() + leadMs >= expiresAtMs;
}

function hashCode(text: string): number {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 33) ^ text.charCodeAt(i);
  }
  return hash >>> 0;
}
