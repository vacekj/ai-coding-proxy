import {
  anthropicMessageToSSEStream,
  xaiResponseToAnthropicMessage,
} from "./anthropic-stream";
import {
  compactedToolResultChars,
  maxRequestChars,
  maxToolResultChars,
  serverIdleTimeoutSeconds,
  serverHost,
  serverPort,
  streamPingMs,
  upstreamModel,
} from "./config";
import {
  defaultOpenCodeModel,
  fetchOpenCodeMessage,
  isOpenCodeModel,
  opencodeModels,
  resolveOpenCodeModel,
  streamOpenCodeMessage,
} from "./opencode";
import {
  clineModels,
  clineRequestCharLimit,
  defaultClineModel,
  fetchClineMessage,
  isClineModel,
  resolveClineModel,
  streamClineMessage,
} from "./cline";
import { estimateAnthropicInputTokens, anthropicToResponses } from "./translate";
import { sanitizeAnthropicRequest } from "./sanitize";
import type { AnthropicMessageRequest } from "./types";
import { fetchXAIResponses, makeSessionId } from "./xai";

const host = serverHost();
const port = serverPort();

const server = Bun.serve({
  hostname: host,
  port,
  idleTimeout: serverIdleTimeoutSeconds(),
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
          cline_model: defaultClineModel().id,
          max_tool_result_chars: maxToolResultChars(),
          max_request_chars: maxRequestChars(),
          cline_request_char_limits: clineRequestCharLimits(),
          compacted_tool_result_chars: compactedToolResultChars(),
          idle_timeout_seconds: serverIdleTimeoutSeconds(),
          stream_ping_ms: streamPingMs(),
        });
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        return json(modelsList());
      }

      if (request.method === "GET" && url.pathname.startsWith("/v1/models/")) {
        return json(modelDetails(decodeURIComponent(url.pathname.slice("/v1/models/".length))));
      }

      if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        const body = (await request.json()) as AnthropicMessageRequest;
        const route = routeProvider(body.model);
        const sanitized = sanitizeAnthropicRequest(body, {
          maxRequestChars: requestCharLimitForRoute(route, body.model),
        });
        return json({
          input_tokens: estimateAnthropicInputTokens(sanitized.request),
          original_input_tokens: estimateAnthropicInputTokens(body),
          sanitized: sanitizeStatsForResponse(sanitized.stats),
        });
      }

      if (
        request.method === "POST" &&
        (url.pathname === "/v1/messages" || url.pathname === "/anthropic/v1/messages")
      ) {
        return await handleMessages(request);
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

console.log(`AI Coding Proxy listening on http://${host}:${server.port}`);
console.log(`Using Grok CLI credentials from ~/.grok/auth.json and model ${upstreamModel()}`);
console.log(`OpenCode Zen models are available in the same server; default ${defaultOpenCodeModel().id}`);
console.log(`ClinePass models are available in the same server; default ${defaultClineModel().id}`);

async function handleMessages(request: Request): Promise<Response> {
  const rawBody = (await request.json()) as AnthropicMessageRequest;
  const route = routeProvider(rawBody.model);
  const { request: body, stats } = sanitizeAnthropicRequest(rawBody, {
    maxRequestChars: requestCharLimitForRoute(route, rawBody.model),
  });
  logSanitization(stats);

  if (route === "cline") {
    if (body.stream) {
      return sseResponse(streamClineMessage(body, { signal: request.signal }));
    }
    return respondWithMessage(fetchClineMessage(body, { signal: request.signal }));
  }

  if (route === "opencode") {
    if (body.stream) {
      return sseResponse(streamOpenCodeMessage(body, { signal: request.signal }));
    }
    return respondWithMessage(fetchOpenCodeMessage(body, { signal: request.signal }));
  }

  const translation = anthropicToResponses(body);
  const sessionId = requestSessionId(request);
  const abortable = makeAbortable(request);

  if (body.stream) {
    const messagePromise = fetchXAIResponses(translation, {
      sessionId,
      signal: abortable.signal,
    }).then((upstream) =>
      xaiResponseToAnthropicMessage(upstream, translation.clientModel, translation.reverseToolNameMap),
    );

    return sseResponse(
      anthropicMessageToSSEStream(messagePromise, {
        signal: abortable.signal,
        abort: abortable.abort,
      }),
    );
  }

  const upstream = await fetchXAIResponses(translation, {
    sessionId,
    signal: abortable.signal,
  });
  const message = await xaiResponseToAnthropicMessage(
    upstream,
    translation.clientModel,
    translation.reverseToolNameMap,
  );
  return json(message);
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

function makeAbortable(request: Request): { signal: AbortSignal; abort: () => void } {
  const controller = new AbortController();
  if (request.signal.aborted) {
    controller.abort();
  } else {
    request.signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return { signal: controller.signal, abort: () => controller.abort() };
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

function logSanitization(stats: ReturnType<typeof sanitizeAnthropicRequest>["stats"]): void {
  if (stats.truncatedToolResults === 0 && stats.compactedToolResults === 0) return;
  console.warn(
    [
      "Sanitized oversized Anthropic request:",
      `${stats.originalChars} chars -> ${stats.sanitizedChars} chars,`,
      `${stats.truncatedToolResults} tool_result(s) truncated,`,
      `${stats.compactedToolResults} tool_result(s) compacted`,
    ].join(" "),
  );
}

function sanitizeStatsForResponse(stats: ReturnType<typeof sanitizeAnthropicRequest>["stats"]) {
  return {
    truncated_tool_results: stats.truncatedToolResults,
    compacted_tool_results: stats.compactedToolResults,
    original_chars: stats.originalChars,
    sanitized_chars: stats.sanitizedChars,
  };
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

function respondWithMessage(
  messagePromise: Promise<import("./translate").AnthropicMessage>,
): Promise<Response> {
  return messagePromise.then((message) => json(message));
}

function modelsList() {
  const grokModel = modelDetails(upstreamModel());
  const opencodeModelDetails = opencodeModels().map((model) => modelDetails(`opencode/${model.id}`));
  const clineModelDetails = clineModels().map((model) => modelDetails(`cline/${model.id}`));
  const data = [grokModel, ...opencodeModelDetails, ...clineModelDetails];
  return {
    data,
    has_more: false,
    first_id: data[0]?.id ?? upstreamModel(),
    last_id: data.at(-1)?.id ?? upstreamModel(),
  };
}

function modelDetails(id: string) {
  const cline = resolveClineModel(id);
  if (cline) {
    return {
      id: id.startsWith("cline/") || id.startsWith("cline-pass/") || id.startsWith("clinepass/")
        ? id
        : `cline/${cline.id}`,
      type: "model",
      display_name: cline.displayName,
      created_at: "2026-07-22T00:00:00Z",
      context_window: cline.contextWindow,
      contextWindow: cline.contextWindow,
      max_input_tokens: cline.contextWindow,
      maxInputTokens: cline.contextWindow,
      input_token_limit: cline.contextWindow,
      compact_at_chars: cline.compactAtChars,
      claude_auto_compact_window: cline.compactAtChars,
      max_output_tokens: cline.maxOutputTokens,
      maxOutputTokens: cline.maxOutputTokens,
    };
  }

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

function routeProvider(model: string | undefined): "opencode" | "cline" | "grok" {
  if (model && isClineModel(model)) return "cline";
  if (model && isOpenCodeModel(model)) return "opencode";

  const provider = process.env.PROXY_PROVIDER?.toLowerCase();
  if (provider === "cline" || provider === "clinepass" || provider === "cline-pass") return "cline";
  if (provider === "opencode") return "opencode";
  return "grok";
}

function requestCharLimitForRoute(
  route: ReturnType<typeof routeProvider>,
  model: string | undefined,
): number | undefined {
  if (route === "cline") return clineRequestCharLimit(model);
  return undefined;
}

function clineRequestCharLimits(): Record<string, number> {
  return Object.fromEntries(clineModels().map((model) => [`cline/${model.id}`, model.compactAtChars]));
}

export { server };
