import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { rm } from "node:fs/promises";
import { parseSSE, type SSEMessage } from "../src/sse";
import type { Server } from "bun";
type ProxyServer = (typeof import("../src/server"))["server"];


const encoder = new TextEncoder();

const originalEnv: Record<string, string | undefined> = {};
const envKeys = [
  "PORT",
  "GROK_CLI_AUTH_FILE",
  "OPENCODE_AUTH_FILE",
  "OPENROUTER_API_KEY",
  "NOUS_API_KEY",
  "NOUS_OPENAI_BASE_URL",
  "PROXY_MAX_TOOL_RESULT_CHARS",
  "PROXY_MAX_REQUEST_CHARS",
] as const;
for (const key of envKeys) originalEnv[key] = process.env[key];

let server: ProxyServer;
let baseUrl: string;
let authFilePath: string;
let opencodeAuthFilePath: string;
let serverStarted = false;

let upstreamHandler: ((url: string, init?: RequestInit) => Response | Promise<Response>) | undefined;

beforeAll(async () => {
  process.env.PORT = String(19_000 + (process.pid % 500));
  process.env.PROXY_MAX_TOOL_RESULT_CHARS = "100";
  process.env.PROXY_MAX_REQUEST_CHARS = "2000";
  process.env.OPENROUTER_API_KEY = "test-openrouter-key";
  process.env.NOUS_API_KEY = "test-nous-key";
  process.env.NOUS_OPENAI_BASE_URL = "https://nous.test/v1/chat/completions";

  authFilePath = `/tmp/ai-coding-proxy-integration-auth-${crypto.randomUUID()}.json`;
  process.env.GROK_CLI_AUTH_FILE = authFilePath;
  await Bun.write(
    authFilePath,
    JSON.stringify({
      "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
        key: "header.payload",
        expires_at: "2099-01-01T00:00:00Z",
      },
    }),
  );

  opencodeAuthFilePath = `/tmp/ai-coding-proxy-integration-opencode-${crypto.randomUUID()}.json`;
  process.env.OPENCODE_AUTH_FILE = opencodeAuthFilePath;
  await Bun.write(
    opencodeAuthFilePath,
    JSON.stringify({ "opencode-go": { type: "api", key: "test-go-key" } }),
  );

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    // Only intercept upstream (non-localhost) calls; client requests to the
    // proxy itself must use the real fetch.
    if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
    if (!upstreamHandler) throw new Error(`Unexpected upstream call: ${u}`);
    return upstreamHandler(u, init);
  }) as typeof fetch;

  const mod = await import("../src/server");
  server = mod.server;
  baseUrl = `http://127.0.0.1:${server.port}`;
  serverStarted = true;
});

afterAll(async () => {
  server?.stop();
  await rm(authFilePath, { force: true });
  await rm(opencodeAuthFilePath, { force: true });
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  serverStarted = false;
});

describe("server health and model listing", () => {
  it("serves /health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(body.default_provider).toBe("grok");
    expect(body.ox_alpha_models).toBe(2);
  });

  it("lists grok and opencode models with context limits", async () => {
    const response = await fetch(`${baseUrl}/v1/models`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Array<Record<string, unknown>>;
    };
    const ids = body.data.map((model) => model.id);
    expect(ids).toContain("grok-composer-2.5-fast");
    expect(ids).toContain("zen/mimo-v2.5-free");
    expect(ids).toContain("openrouter/ox-alpha");
    expect(ids).toContain("hermes/ox-alpha");
    const detail = body.data.find((model) => model.id === "zen/x-preview-f-free")!;
    expect(detail.context_window).toBe(1_000_000);
    expect(detail.max_output_tokens).toBe(131_072);
    const ox = body.data.find((model) => model.id === "openrouter/ox-alpha")!;
    expect(ox.context_window).toBe(1_048_576);
    expect(ox.max_output_tokens).toBe(131_072);
  });

  it("returns 404 for unknown routes", async () => {
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { type: string } };
    expect(body.error.type).toBe("not_found_error");
  });
});

describe("grok route", () => {
  it("returns a buffered Anthropic message for non-stream requests", async () => {
    upstreamHandler = () =>
      Response.json({
        id: "resp_1",
        object: "response",
        model: "grok-composer-2.5-fast",
        output: [
          {
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "hello from grok" }],
          },
        ],
        usage: { input_tokens: 10, output_tokens: 5 },
        stop_reason: "end_turn",
      });

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "grok-composer-2.5-fast",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const message = (await response.json()) as {
      type: string;
      content: Array<{ type: string; text: string }>;
      usage: { input_tokens: number };
    };
    expect(message.type).toBe("message");
    expect(message.content).toEqual([{ type: "text", text: "hello from grok" }]);
    expect(message.usage.input_tokens).toBe(10);
  });

  it("streams Anthropic SSE events from a CRLF upstream and reports cache reads", async () => {
    upstreamHandler = () =>
      new Response(
        [
          `event: response.output_item.done\r\ndata: ${JSON.stringify({
            type: "response.output_item.done",
            output_index: 0,
            item: {
              type: "message",
              id: "msg_1",
              role: "assistant",
              content: [{ type: "output_text", text: "crlf works" }],
            },
          })}\r\n\r\n`,
          `event: response.completed\r\ndata: ${JSON.stringify({
            type: "response.completed",
            response: {
              id: "resp_1",
              object: "response",
              model: "grok-composer-2.5-fast",
              output: [
                {
                  type: "message",
                  id: "msg_1",
                  role: "assistant",
                  content: [{ type: "output_text", text: "crlf works" }],
                },
              ],
              usage: {
                input_tokens: 8,
                output_tokens: 3,
                input_tokens_details: { cached_tokens: 5 },
              },
              stop_reason: "end_turn",
            },
          })}\r\n\r\n`,
        ].join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "grok-composer-2.5-fast",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const events = await collectEvents(response);
    const names = events.map((event) => event.event);

    expect(names).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);

    const start = events.find((event) => event.event === "message_start")!.parsed as {
      message: { usage: Record<string, unknown>; model: string };
    };
    expect(start.message.model).toBe("grok-composer-2.5-fast");
    expect(start.message.usage.input_tokens).toBe(3);
    expect(start.message.usage.cache_read_input_tokens).toBe(5);

    const delta = events.find((event) => event.event === "content_block_delta")!.parsed as {
      delta: { type: string; text: string };
    };
    expect(delta.delta).toEqual({ type: "text_delta", text: "crlf works" });
  });

  it("counts tokens and reports sanitization stats", async () => {
    const response = await fetch(`${baseUrl}/v1/messages/count_tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "grok-composer-2.5-fast",
        messages: [
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "a".repeat(5000) },
            ],
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      input_tokens: number;
      original_input_tokens: number;
      sanitized: { truncated_tool_results: number; original_chars: number; sanitized_chars: number };
    };
    expect(body.sanitized.truncated_tool_results).toBe(1);
    expect(body.sanitized.sanitized_chars).toBeLessThan(body.sanitized.original_chars);
    expect(body.input_tokens).toBeLessThan(body.original_input_tokens);
  });

  it("aborts the upstream fetch when the client disconnects mid-stream", async () => {
    process.env.PROXY_STREAM_PING_MS = "50";
    let upstreamSignal: AbortSignal | undefined;

    upstreamHandler = (_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: response.output_item.done\ndata: ${JSON.stringify({
                type: "response.output_item.done",
                output_index: 0,
                item: {
                  type: "message",
                  id: "msg_1",
                  role: "assistant",
                  content: [{ type: "output_text", text: "partial" }],
                },
              })}\n\n`,
            ),
          );
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    };

    try {
      await postAndDisconnect(server.port!, {
        model: "grok-composer-2.5-fast",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      });

      await waitFor(() => upstreamSignal?.aborted === true, 3000);
    } finally {
      delete process.env.PROXY_STREAM_PING_MS;
    }
  });
});

describe("Ox Alpha routes", () => {
  it("routes OpenRouter with its API key and Ox Alpha reasoning contract", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    upstreamHandler = (url, init) => {
      captured = {
        url,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return Response.json({
        id: "chatcmpl_ox",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", reasoning: "checked", content: "openrouter works" },
          },
        ],
        usage: { prompt_tokens: 4, completion_tokens: 3 },
      });
    };

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/ox-alpha",
        max_tokens: 64,
        output_config: { effort: "xhigh" },
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(captured?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(captured?.headers.get("authorization")).toBe("Bearer test-openrouter-key");
    expect(captured?.body.model).toBe("stealth/ox-alpha");
    expect(captured?.body.reasoning).toEqual({ effort: "max" });
    expect(captured?.body.effort).toBeUndefined();

    const message = (await response.json()) as { model: string; content: Array<Record<string, unknown>> };
    expect(message.model).toBe("openrouter/ox-alpha");
    expect(message.content).toEqual([
      { type: "thinking", thinking: "checked" },
      { type: "text", text: "openrouter works" },
    ]);
  });

  it("routes Hermes to the Nous Portal API with its key", async () => {
    let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    upstreamHandler = (url, init) => {
      captured = {
        url,
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return Response.json({
        id: "chatcmpl_hermes_ox",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "portal works" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      });
    };

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "hermes/stealth/ox-alpha",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(captured?.url).toBe("https://nous.test/v1/chat/completions");
    expect(captured?.headers.get("authorization")).toBe("Bearer test-nous-key");
    expect(captured?.body.model).toBe("stealth/ox-alpha");
  });

  it("translates OpenRouter reasoning stream deltas", async () => {
    upstreamHandler = () =>
      sseResponse(
        [
          { delta: { role: "assistant", reasoning: "considering" } },
          { delta: { content: "done" } },
        ]
          .map(
            (chunk) =>
              `data: ${JSON.stringify({
                id: "chatcmpl_ox_stream",
                choices: [{ index: 0, ...chunk, finish_reason: null }],
              })}\n\n`,
          )
          .join("") +
          `data: ${JSON.stringify({
            id: "chatcmpl_ox_stream",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\n` +
          "data: [DONE]\n\n",
      );

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "openrouter/ox-alpha",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    const events = await collectEvents(response);
    const deltas = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => (event.parsed as { delta: Record<string, unknown> }).delta);
    expect(deltas).toContainEqual({ type: "thinking_delta", thinking: "considering" });
    expect(deltas).toContainEqual({ type: "text_delta", text: "done" });
  });
});

describe("opencode route", () => {
  it("streams via the OpenAI chat protocol relay", async () => {
    let captured: { headers: Headers; body: Record<string, unknown> } | undefined;

    upstreamHandler = (url, init) => {
      captured = {
        headers: new Headers(init?.headers),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      };
      return sseResponse(
        [
          { delta: { role: "assistant", content: "zen" } },
          { delta: { reasoning_content: "thinking hard" } },
          { delta: { content: " reply" } },
        ]
          .map(
            (chunk) =>
              `data: ${JSON.stringify({
                id: "chatcmpl_2",
                object: "chat.completion.chunk",
                choices: [{ index: 0, ...chunk, finish_reason: null }],
              })}\n\n`,
          )
          .join("") +
          `data: ${JSON.stringify({
            id: "chatcmpl_2",
            object: "chat.completion.chunk",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } },
          })}\n\n` +
          "data: [DONE]\n\n",
      );
    };

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "go/kimi-k2.6",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(captured?.body.model).toBe("kimi-k2.6");
    expect(captured?.body.stream).toBe(true);
    expect(captured?.headers.get("authorization")).toBe("Bearer test-go-key");

    const events = await collectEvents(response);
    const deltas = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => event.parsed as { delta: { type: string; text?: string } });

    const textDeltas = events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => (event.parsed as { delta: { type: string; text?: string } }).delta)
      .filter((delta) => delta.type === "text_delta");
    expect(textDeltas.map((delta) => delta.text).join("")).toBe("zen reply");
    expect(deltas.some((d) => d.delta.type === "thinking_delta")).toBe(true);

    const start = events.find((event) => event.event === "message_start")!.parsed as {
      message: { model: string };
    };
    expect(start.message.model).toBe("go/kimi-k2.6");

    const finalDelta = events.find((event) => event.event === "message_delta")!.parsed as {
      usage: { output_tokens: number };
    };
    expect(finalDelta.usage.output_tokens).toBe(6);
  });

  it("relays the anthropic-protocol upstream with the client model rewritten", async () => {
    upstreamHandler = () =>
      new Response(
        [
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: { id: "msg_up", type: "message", role: "assistant", model: "qwen3.7-max", content: [] },
          })}\n\n`,
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "text_delta", text: "relayed" },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
          `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
        ].join(""),
        { headers: { "Content-Type": "text/event-stream" } },
      );

    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "go/qwen3.7-max",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(200);
    const events = await collectEvents(response);
    const start = events.find((event) => event.event === "message_start")!.parsed as {
      message: { model: string; id: string };
    };
    expect(start.message.model).toBe("go/qwen3.7-max");
    expect(start.message.id).toBe("msg_up");

    const delta = events.find((event) => event.event === "content_block_delta")!.parsed as {
      delta: { type: string; text: string };
    };
    expect(delta.delta).toEqual({ type: "text_delta", text: "relayed" });
    expect(events.at(-1)?.event).toBe("message_stop");
  });

  it("aborts the upstream fetch when the client disconnects mid-stream", async () => {
    let upstreamSignal: AbortSignal | undefined;

    upstreamHandler = (_url, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({
                  id: "chatcmpl_3",
                  object: "chat.completion.chunk",
                  choices: [{ index: 0, delta: { role: "assistant", content: "x" }, finish_reason: null }],
                })}\n\n`,
              ),
            );
          },
        }),
        { headers: { "Content-Type": "text/event-stream" } },
      );
    };

    await postAndDisconnect(server.port!, {
      model: "go/kimi-k2.6",
      max_tokens: 64,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });

    await waitFor(() => upstreamSignal?.aborted === true, 3000);
  });
});

interface ParsedEvent extends SSEMessage {
  parsed: unknown;
}

async function collectEvents(response: Response): Promise<ParsedEvent[]> {
  const events: ParsedEvent[] = [];
  for await (const message of parseSSE(response.body!)) {
    if (message.event === "ping") continue;
    events.push({ ...message, parsed: JSON.parse(message.data) });
  }
  return events;
}

function sseResponse(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Condition not met within timeout");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

// Bun.serve does not surface client disconnects to fetch()-based clients in the
// same process (no cancel(), no request.signal abort), so simulate a real TCP
// client that abandons the connection mid-response.
async function postAndDisconnect(port: number, body: object): Promise<void> {
  const { connect } = await import("node:net");
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1");
    const payload = JSON.stringify(body);
    socket.on("connect", () => {
      socket.write(
        `POST /v1/messages HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`,
      );
    });
    socket.on("error", () => {
      // Connection reset after destroy is expected.
    });
    let disconnected = false;
    const disconnect = () => {
      if (disconnected) return;
      disconnected = true;
      socket.destroy();
      resolve();
    };
    socket.on("data", disconnect);
    setTimeout(disconnect, 1000);
  });
}
