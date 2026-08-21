import { afterEach, describe, expect, it } from "bun:test";
import {
  defaultOpenCodeModel,
  fetchOpenCodeMessage,
  opencodeModels,
  resolveOpenCodeModel,
} from "../src/opencode";

const originalFetch = globalThis.fetch;
const originalOpenCodeProxyModel = process.env.OPENCODE_PROXY_MODEL;

// Go models authenticate with the key the OpenCode CLI stores; point at a fixture.
const goAuthFilePath = `/tmp/ai-coding-proxy-opencode-auth-${crypto.randomUUID()}.json`;
await Bun.write(goAuthFilePath, JSON.stringify({ "opencode-go": { type: "api", key: "test-go-key" } }));
process.env.OPENCODE_AUTH_FILE = goAuthFilePath;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalOpenCodeProxyModel == null) delete process.env.OPENCODE_PROXY_MODEL;
  else process.env.OPENCODE_PROXY_MODEL = originalOpenCodeProxyModel;
});

describe("fetchOpenCodeMessage", () => {
  it("uses Mimo as the unauthenticated OpenCode default", async () => {
    delete process.env.OPENCODE_PROXY_MODEL;

    const body = await openCodeRequestBody({
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(defaultOpenCodeModel().id).toBe("zen/mimo-v2.5-free");
    expect(body.model).toBe("mimo-v2.5-free");
  });

  it("maps Claude thinking effort to DeepSeek V4 reasoning_effort", async () => {
    const body = await openCodeRequestBody({
      model: "go/deepseek-v4-flash-vision-exp",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "medium" },
    });

    expect(body.reasoning_effort).toBe("high");
    expect(body.effort).toBeUndefined();
  });

  it("maps Claude disabled and max effort to DeepSeek V4 modes", async () => {
    const disabled = await openCodeRequestBody({
      model: "go/deepseek-v4-flash-vision-exp",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    });
    const max = await openCodeRequestBody({
      model: "go/deepseek-v4-flash-vision-exp",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "xhigh" },
    });

    expect(disabled.reasoning_effort).toBe("none");
    expect(max.reasoning_effort).toBe("max");
  });

  it("keeps generic effort for non-DeepSeek OpenAI-compatible OpenCode models", async () => {
    const body = await openCodeRequestBody({
      model: "go/kimi-k2.6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "medium" },
    });

    expect(body.effort).toBe("medium");
    expect(body.reasoning_effort).toBeUndefined();
  });
});

describe("plan routing", () => {
  it("sends Zen free models unauthenticated to the Zen endpoint", async () => {
    const call = await openCodeCall({
      model: "zen/hy3-free",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(call.url).toBe("https://opencode.ai/zen/v1/chat/completions");
    expect(call.headers.get("authorization")).toBeNull();
    expect(call.body.model).toBe("hy3-free");
  });

  it("sends Go models to the Go endpoint with the CLI subscription key", async () => {
    const call = await openCodeCall({
      model: "go/glm-5.3",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(call.url).toBe("https://opencode.ai/zen/go/v1/chat/completions");
    expect(call.headers.get("authorization")).toBe("Bearer test-go-key");
    expect(call.body.model).toBe("glm-5.3");
  });

  it("uses the native Anthropic passthrough for Go models that support it", async () => {
    const call = await openCodeCall({
      model: "go/minimax-m3",
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(call.url).toBe("https://opencode.ai/zen/go/v1/messages");
    expect(call.headers.get("x-api-key")).toBe("test-go-key");
    expect(call.headers.get("anthropic-version")).toBe("2023-06-01");
  });
});

describe("model id resolution", () => {
  it("prefers Zen for bare ids and falls back to Go", () => {
    expect(resolveOpenCodeModel("mimo-v2.5-free")?.id).toBe("zen/mimo-v2.5-free");
    expect(resolveOpenCodeModel("glm-5.3")?.id).toBe("go/glm-5.3");
  });

  it("still accepts the legacy opencode/ prefix as Zen", () => {
    expect(resolveOpenCodeModel("opencode/hy3-free")?.id).toBe("zen/hy3-free");
  });

  it("strips the Claude Code 1M context marker", () => {
    expect(resolveOpenCodeModel("go/kimi-k3[1m]")?.id).toBe("go/kimi-k3");
  });

  it("ignores models it does not serve", () => {
    expect(resolveOpenCodeModel("claude-sonnet-5")).toBeUndefined();
    expect(resolveOpenCodeModel("zen/deepseek-v4-flash-free")).toBeUndefined();
  });

  it("marks text-only models so screenshots are not forwarded", () => {
    const textOnly = opencodeModels().filter((model) => model.noMultimodal).map((model) => model.id);
    expect(textOnly).toContain("zen/hy3-free");
    expect(textOnly).toContain("go/glm-5.1");
    expect(textOnly).not.toContain("zen/mimo-v2.5-free");
  });
});

async function openCodeCall(input: Parameters<typeof fetchOpenCodeMessage>[0]): Promise<{
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}> {
  let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (url, init) => {
    captured = {
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return Response.json({
      id: "msg_test",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, input_tokens: 1, output_tokens: 1 },
    });
  }) as typeof fetch;

  await fetchOpenCodeMessage(input);
  if (!captured) throw new Error("No upstream call captured");
  return captured;
}

async function openCodeRequestBody(input: Parameters<typeof fetchOpenCodeMessage>[0]): Promise<Record<string, unknown>> {
  let requestBody: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url, init) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({
      id: "chatcmpl_test",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }) as typeof fetch;

  await fetchOpenCodeMessage(input);
  if (!requestBody) throw new Error("No request body captured");
  return requestBody;
}
