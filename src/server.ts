import {
  anthropicMessageToSSEStream,
  xaiResponseToAnthropicMessage,
} from "./anthropic-stream";
import { serverHost, serverPort, upstreamModel } from "./config";
import { estimateAnthropicInputTokens, anthropicToResponses } from "./translate";
import type { AnthropicMessageRequest } from "./types";
import { fetchXAIResponses, makeSessionId } from "./xai";

const host = serverHost();
const port = serverPort();

const server = Bun.serve({
  hostname: host,
  port,
  async fetch(request) {
    try {
      const url = new URL(request.url);

      if (request.method === "OPTIONS") return new Response(null, { status: 204 });
      if (url.pathname === "/health") {
        return json({ ok: true, model: upstreamModel() });
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        return json(modelsList());
      }

      if (request.method === "GET" && url.pathname.startsWith("/v1/models/")) {
        return json(modelDetails(decodeURIComponent(url.pathname.split("/").at(-1) ?? "")));
      }

      if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        const body = (await request.json()) as AnthropicMessageRequest;
        return json({ input_tokens: estimateAnthropicInputTokens(body) });
      }

      if (request.method === "POST" && url.pathname === "/v1/messages") {
        return handleMessages(request);
      }

      return json(
        {
          type: "error",
          error: { type: "not_found_error", message: `No route for ${request.method} ${url.pathname}` },
        },
        { status: 404 },
      );
    } catch (error) {
      return json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        { status: 500 },
      );
    }
  },
});

console.log(`Grok Composer Claude proxy listening on http://${host}:${server.port}`);
console.log(`Using Grok CLI credentials from ~/.grok/auth.json and model ${upstreamModel()}`);

async function handleMessages(request: Request): Promise<Response> {
  const body = (await request.json()) as AnthropicMessageRequest;
  const translation = anthropicToResponses(body);
  const sessionId = requestSessionId(request);

  if (body.stream) {
    const messagePromise = fetchXAIResponses(translation, {
      sessionId,
      signal: request.signal,
    }).then((upstream) =>
      xaiResponseToAnthropicMessage(upstream, translation.clientModel, translation.reverseToolNameMap),
    );

    return new Response(anthropicMessageToSSEStream(messagePromise), {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  }

  const upstream = await fetchXAIResponses(translation, {
    sessionId,
    signal: request.signal,
  });
  const message = await xaiResponseToAnthropicMessage(
    upstream,
    translation.clientModel,
    translation.reverseToolNameMap,
  );
  return json(message);
}

function requestSessionId(request: Request): string {
  return makeSessionId(
    request.headers.get("x-grok-conv-id") ??
      request.headers.get("x-session-id") ??
      request.headers.get("x-claude-session-id") ??
      request.headers.get("anthropic-session-id") ??
      undefined,
  );
}

function json(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
}

function modelsList() {
  const model = modelDetails(upstreamModel());
  return {
    data: [model],
    has_more: false,
    first_id: model.id,
    last_id: model.id,
  };
}

function modelDetails(id: string) {
  return {
    id: id || upstreamModel(),
    type: "model",
    display_name: "Composer 2.5 Fast",
    created_at: "2026-06-02T00:00:00Z",
  };
}

export { server };
