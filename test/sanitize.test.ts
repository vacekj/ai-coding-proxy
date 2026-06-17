import { afterEach, describe, expect, it } from "bun:test";
import { sanitizeAnthropicRequest } from "../src/sanitize";
import type { AnthropicContentBlock } from "../src/types";

const originalEnv = {
  PROXY_MAX_TOOL_RESULT_CHARS: process.env.PROXY_MAX_TOOL_RESULT_CHARS,
  PROXY_MAX_REQUEST_CHARS: process.env.PROXY_MAX_REQUEST_CHARS,
  PROXY_COMPACTED_TOOL_RESULT_CHARS: process.env.PROXY_COMPACTED_TOOL_RESULT_CHARS,
};

afterEach(() => {
  restoreEnv("PROXY_MAX_TOOL_RESULT_CHARS");
  restoreEnv("PROXY_MAX_REQUEST_CHARS");
  restoreEnv("PROXY_COMPACTED_TOOL_RESULT_CHARS");
});

describe("sanitizeAnthropicRequest", () => {
  it("preserves small tool results", () => {
    process.env.PROXY_MAX_TOOL_RESULT_CHARS = "100";

    const result = sanitizeAnthropicRequest({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "small output" }],
        },
      ],
    });

    const block = firstContentBlock(result);
    expect(block).toEqual({ type: "tool_result", tool_use_id: "tool_1", content: "small output" });
    expect(result.stats.truncatedToolResults).toBe(0);
  });

  it("truncates large tool results with a clear marker", () => {
    process.env.PROXY_MAX_TOOL_RESULT_CHARS = "120";

    const result = sanitizeAnthropicRequest({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "a".repeat(500) }],
        },
      ],
    });

    const block = firstContentBlock(result);
    expect(block?.type).toBe("tool_result");
    expect(String(block?.content)).toContain("large tool result truncated by proxy");
    expect(String(block?.content).length).toBeLessThan(500);
    expect(result.stats.truncatedToolResults).toBe(1);
  });

  it("compacts older tool results when the whole request is still too large", () => {
    process.env.PROXY_MAX_TOOL_RESULT_CHARS = "1000";
    process.env.PROXY_MAX_REQUEST_CHARS = "1400";
    process.env.PROXY_COMPACTED_TOOL_RESULT_CHARS = "120";

    const result = sanitizeAnthropicRequest({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "a".repeat(900) }],
        },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_2", content: "b".repeat(900) }],
        },
      ],
    });

    expect(result.stats.compactedToolResults).toBeGreaterThan(0);
    expect(JSON.stringify(result.request).length).toBeLessThanOrEqual(1400);
    expect(JSON.stringify(result.request)).toContain("older tool result compacted by proxy");
  });

  it("uses an explicit whole-request budget when provided", () => {
    process.env.PROXY_MAX_TOOL_RESULT_CHARS = "1000";
    process.env.PROXY_MAX_REQUEST_CHARS = "5000";
    process.env.PROXY_COMPACTED_TOOL_RESULT_CHARS = "120";

    const result = sanitizeAnthropicRequest(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool_1", content: "a".repeat(900) }],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "tool_2", content: "b".repeat(900) }],
          },
        ],
      },
      { maxRequestChars: 1400 },
    );

    expect(result.stats.compactedToolResults).toBeGreaterThan(0);
    expect(JSON.stringify(result.request).length).toBeLessThanOrEqual(1400);
  });
});

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}

function firstContentBlock(result: ReturnType<typeof sanitizeAnthropicRequest>): AnthropicContentBlock | undefined {
  const content = result.request.messages?.[0]?.content;
  return Array.isArray(content) ? content[0] : undefined;
}
