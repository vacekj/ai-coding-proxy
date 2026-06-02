import { encodeSSE, parseSSE } from "./sse";
import type { AnthropicContentBlock, XAIOutputItem, XAIResponse, XAIStreamEvent } from "./types";
import {
  type AnthropicMessage,
  responseToAnthropicMessage,
} from "./translate";

export async function collectXAIResponse(response: Response): Promise<XAIResponse> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return (await response.json()) as XAIResponse;
  }

  if (!response.body) {
    throw new Error("xAI upstream returned an empty response body");
  }

  let completed: XAIResponse | undefined;
  const outputByIndex = new Map<number, XAIOutputItem>();
  const outputFallback: XAIOutputItem[] = [];

  for await (const message of parseSSE(response.body)) {
    if (message.data === "[DONE]") continue;
    let event: XAIStreamEvent;
    try {
      event = JSON.parse(message.data) as XAIStreamEvent;
    } catch {
      continue;
    }

    if (event.type === "response.output_item.done" && event.item) {
      if (typeof event.output_index === "number") outputByIndex.set(event.output_index, event.item);
      else outputFallback.push(event.item);
    }

    if (event.type === "response.completed" && event.response) {
      completed = event.response;
    }
  }

  if (!completed) {
    throw new Error("xAI stream ended before response.completed");
  }

  if (!Array.isArray(completed.output) || completed.output.length === 0) {
    completed.output = [
      ...[...outputByIndex.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
      ...outputFallback,
    ];
  }

  return completed;
}

export async function xaiResponseToAnthropicMessage(
  upstream: Response,
  clientModel: string,
  reverseToolNameMap: Map<string, string>,
): Promise<AnthropicMessage> {
  return responseToAnthropicMessage(
    await collectXAIResponse(upstream),
    clientModel,
    reverseToolNameMap,
  );
}

export function anthropicMessageToSSEStream(messagePromise: Promise<AnthropicMessage>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(encodeSSE(event, data)));
      };

      try {
        const message = await messagePromise;
        send("message_start", {
          type: "message_start",
          message: {
            id: message.id,
            type: "message",
            role: "assistant",
            model: message.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: message.usage.input_tokens,
              cache_read_input_tokens: message.usage.cache_read_input_tokens,
              output_tokens: 0,
            },
          },
        });

        message.content.forEach((block, index) => {
          emitContentBlock(send, block, index);
        });

        send("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: message.stop_reason,
            stop_sequence: message.stop_sequence,
          },
          usage: { output_tokens: message.usage.output_tokens },
        });
        send("message_stop", { type: "message_stop" });
        controller.close();
      } catch (error) {
        send("error", {
          type: "error",
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        controller.close();
      }
    },
  });
}

function emitContentBlock(
  send: (event: string, data: unknown) => void,
  block: AnthropicContentBlock,
  index: number,
): void {
  switch (block.type) {
    case "thinking": {
      const thinking = String(block.thinking ?? block.text ?? "");
      send("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "thinking", thinking: "" },
      });
      if (thinking) {
        send("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking },
        });
      }
      if (typeof block.signature === "string" && block.signature) {
        send("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: block.signature },
        });
      }
      send("content_block_stop", { type: "content_block_stop", index });
      return;
    }
    case "tool_use": {
      send("content_block_start", {
        type: "content_block_start",
        index,
        content_block: {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: {},
        },
      });
      send("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: {
          type: "input_json_delta",
          partial_json: JSON.stringify(block.input ?? {}),
        },
      });
      send("content_block_stop", { type: "content_block_stop", index });
      return;
    }
    default: {
      const text = block.type === "text" ? block.text : "";
      send("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      if (text) {
        send("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text },
        });
      }
      send("content_block_stop", { type: "content_block_stop", index });
    }
  }
}
