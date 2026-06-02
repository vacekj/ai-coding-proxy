import {
  anthropicMessageToSSEStream,
  xaiResponseToAnthropicMessage,
} from "./anthropic-stream";
import { serverHost, serverPort, upstreamModel } from "./config";
import {
  defaultOpenCodeModel,
  fetchOpenCodeMessage,
  isOpenCodeModel,
  openCodeModels,
  resolveOpenCodeModel,
} from "./opencode";
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
        return json({
          ok: true,
          default_provider: "grok",
          grok_model: upstreamModel(),
          opencode_model: defaultOpenCodeModel().id,
        });
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

      if (
        request.method === "POST" &&
        (url.pathname === "/v1/messages" || url.pathname === "/anthropic/v1/messages")
      ) {
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
      const status =
        error && typeof error === "object" && "status" in error && typeof error.status === "number"
          ? error.status
          : 500;
      return json(
        {
          type: "error",
          error: {
            type: "api_error",
            message: error instanceof Error ? error.message : String(error),
          },
        },
        { status },
      );
    }
  },
});

console.log(`Grok Composer Claude proxy listening on http://${host}:${server.port}`);
console.log(`Using Grok CLI credentials from ~/.grok/auth.json and model ${upstreamModel()}`);
console.log(`OpenCode Zen models are available in the same server; default ${defaultOpenCodeModel().id}`);

async function handleMessages(request: Request): Promise<Response> {
  const body = (await request.json()) as AnthropicMessageRequest;
  if (shouldUseOpenCode(body.model)) {
    const messagePromise = fetchOpenCodeMessage(body, { signal: request.signal });
    if (body.stream) {
      return new Response(anthropicMessageToSSEStream(messagePromise), {
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }
    return json(await messagePromise);
  }

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
  const grokModel = modelDetails(upstreamModel());
  const opencodeModels = openCodeModels().map((model) => modelDetails(`opencode/${model.id}`));
  const data = [grokModel, ...opencodeModels];
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? upstreamModel(),
    last_id: data.at(-1)?.id ?? upstreamModel(),
  };
}

function modelDetails(id: string) {
  const opencode = resolveOpenCodeModel(id);
  if (opencode) {
    return {
      id: id || `opencode/${opencode.id}`,
      type: "model",
      display_name: opencode.displayName,
      created_at: "2026-06-02T00:00:00Z",
    };
  }

  return {
    id: id || upstreamModel(),
    type: "model",
    display_name: "Composer 2.5 Fast",
    created_at: "2026-06-02T00:00:00Z",
  };
}

function shouldUseOpenCode(model: string | undefined): boolean {
  if (model && isOpenCodeModel(model)) return true;
  return process.env.PROXY_PROVIDER?.toLowerCase() === "opencode";
}

export { server };
