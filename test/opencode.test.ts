import { afterEach, describe, expect, it } from "bun:test";
import { defaultOpenCodeModel, fetchOpenCodeMessage } from "../src/opencode";

const originalFetch = globalThis.fetch;
const originalOpenCodeProxyModel = process.env.OPENCODE_PROXY_MODEL;

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

    expect(defaultOpenCodeModel().id).toBe("mimo-v2.5-free");
    expect(body.model).toBe("mimo-v2.5-free");
  });

  it("maps Claude thinking effort to DeepSeek V4 reasoning_effort", async () => {
    const body = await openCodeRequestBody({
      model: "opencode/deepseek-v4-flash-free",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "medium" },
    });

    expect(body.reasoning_effort).toBe("high");
    expect(body.effort).toBeUndefined();
  });

  it("maps Claude disabled and max effort to DeepSeek V4 modes", async () => {
    const disabled = await openCodeRequestBody({
      model: "opencode/deepseek-v4-flash",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    });
    const max = await openCodeRequestBody({
      model: "opencode/deepseek-v4-flash",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "xhigh" },
    });

    expect(disabled.reasoning_effort).toBe("none");
    expect(max.reasoning_effort).toBe("max");
  });

  it("keeps generic effort for non-DeepSeek OpenAI-compatible Zen models", async () => {
    const body = await openCodeRequestBody({
      model: "opencode/kimi-k2.6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "medium" },
    });

    expect(body.effort).toBe("medium");
    expect(body.reasoning_effort).toBeUndefined();
  });
});

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
