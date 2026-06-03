import { afterEach, describe, expect, it } from "bun:test";
import { anthropicMessageToSSEStream } from "../src/anthropic-stream";
import { parseSSE } from "../src/sse";

const originalPingMs = process.env.PROXY_STREAM_PING_MS;

afterEach(() => {
  if (originalPingMs == null) delete process.env.PROXY_STREAM_PING_MS;
  else process.env.PROXY_STREAM_PING_MS = originalPingMs;
});

describe("anthropicMessageToSSEStream", () => {
  it("emits ping events while waiting for a delayed message", async () => {
    process.env.PROXY_STREAM_PING_MS = "10";

    const stream = anthropicMessageToSSEStream(
      sleep(35).then(() => ({
        id: "msg_test",
        type: "message" as const,
        role: "assistant" as const,
        model: "test-model",
        content: [{ type: "text" as const, text: "done" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      })),
    );

    const events: string[] = [];
    for await (const message of parseSSE(stream)) {
      if (message.event) events.push(message.event);
      if (message.event === "message_start") break;
    }

    expect(events).toContain("ping");
    expect(events.at(-1)).toBe("message_start");
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
