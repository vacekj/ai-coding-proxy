import { afterEach, describe, expect, it } from "bun:test";
import {
  fetchOxAlphaMessage,
  oxAlphaModels,
  resolveOxAlphaModel,
} from "../src/ox-alpha";

const originalFetch = globalThis.fetch;
const envKeys = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_OPENAI_BASE_URL",
  "NOUS_API_KEY",
  "NOUS_OPENAI_BASE_URL",
] as const;
const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of envKeys) {
    const value = originalEnv[key];
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("Ox Alpha model registry", () => {
  it("exposes one explicit route per free gateway", () => {
    expect(oxAlphaModels().map((model) => model.id)).toEqual([
      "openrouter/ox-alpha",
      "hermes/ox-alpha",
    ]);
  });

  it("accepts provider-native aliases and the Claude Code context marker", () => {
    expect(resolveOxAlphaModel("openrouter/stealth/ox-alpha")?.id).toBe("openrouter/ox-alpha");
    expect(resolveOxAlphaModel("nous:stealth/ox-alpha[1m]")?.id).toBe("hermes/ox-alpha");
    expect(resolveOxAlphaModel("ox-alpha")).toBeUndefined();
  });
});

describe("Ox Alpha credentials and translation", () => {
  it("requires an OpenRouter API key", async () => {
    delete process.env.OPENROUTER_API_KEY;
    await expect(
      fetchOxAlphaMessage(
        { model: "openrouter/ox-alpha", messages: [{ role: "user", content: "hi" }] },
        "openrouter",
      ),
    ).rejects.toThrow("OPENROUTER_API_KEY");
  });

  it("requires a Nous Portal API key", async () => {
    delete process.env.NOUS_API_KEY;
    await expect(
      fetchOxAlphaMessage(
        { model: "hermes/ox-alpha", messages: [{ role: "user", content: "hi" }] },
        "hermes",
      ),
    ).rejects.toThrow("NOUS_API_KEY");
  });

  it("calls the Nous Portal API directly", async () => {
    process.env.NOUS_API_KEY = "test-nous-key";
    process.env.NOUS_OPENAI_BASE_URL = "https://nous.test/v1/chat/completions";

    const call = await capturedCall(
      {
        model: "hermes/ox-alpha",
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      },
      "hermes",
    );

    expect(call.url).toBe("https://nous.test/v1/chat/completions");
    expect(call.headers.get("authorization")).toBe("Bearer test-nous-key");
  });

  it("preserves reasoning across a tool-result continuation", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";

    const call = await capturedCall(
      {
        model: "openrouter/ox-alpha",
        max_tokens: 64,
        output_config: { effort: "medium" },
        tools: [{ name: "Bash", input_schema: { type: "object" } }],
        messages: [
          { role: "user", content: "run pwd" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should use the tool" },
              { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "/tmp" }],
          },
        ],
      },
      "openrouter",
    );

    expect(call.body.reasoning).toEqual({ effort: "high" });
    const messages = call.body.messages as Array<Record<string, unknown>>;
    const assistant = messages.find((message) => message.role === "assistant")!;
    expect(assistant.reasoning_content).toBe("I should use the tool");
  });

  it("maps disabled thinking to Ox Alpha's mandatory minimum effort", async () => {
    process.env.OPENROUTER_API_KEY = "test-openrouter-key";

    const call = await capturedCall(
      {
        model: "openrouter/ox-alpha",
        max_tokens: 64,
        thinking: { type: "disabled" },
        messages: [{ role: "user", content: "hi" }],
      },
      "openrouter",
    );

    expect(call.body.reasoning).toEqual({ effort: "low" });
  });
});

async function capturedCall(
  input: Parameters<typeof fetchOxAlphaMessage>[0],
  provider: Parameters<typeof fetchOxAlphaMessage>[1],
): Promise<{ url: string; headers: Headers; body: Record<string, unknown> }> {
  let captured: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
  globalThis.fetch = (async (url, init) => {
    captured = {
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return Response.json({
      id: "chatcmpl_test",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }) as typeof fetch;

  await fetchOxAlphaMessage(input, provider);
  if (!captured) throw new Error("No upstream call captured");
  return captured;
}
