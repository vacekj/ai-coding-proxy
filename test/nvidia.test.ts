import { afterEach, describe, expect, it } from "bun:test";
import { fetchNvidiaMessage, nvidiaRequestCharLimit, resolveNvidiaModel } from "../src/nvidia";

const originalFetch = globalThis.fetch;
const originalEnv = {
  NVIDIA_API_KEY: process.env.NVIDIA_API_KEY,
  NVIDIA_OPENAI_BASE_URL: process.env.NVIDIA_OPENAI_BASE_URL,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("NVIDIA_API_KEY");
  restoreEnv("NVIDIA_OPENAI_BASE_URL");
});

describe("fetchNvidiaMessage", () => {
  it("maps short DeepSeek V4 aliases to NVIDIA and enables max thinking", async () => {
    const captured = await nvidiaRequest({
      model: "nvidia/dsv4-pro",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(captured.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(captured.authorization).toBe("Bearer test-nvidia-key");
    expect(captured.body.model).toBe("deepseek-ai/deepseek-v4-pro");
    expect(captured.body.temperature).toBe(1);
    expect(captured.body.top_p).toBe(0.95);
    expect(captured.body.reasoning_effort).toBeUndefined();
    expect(captured.body.chat_template_kwargs).toEqual({
      thinking: true,
      reasoning_effort: "max",
    });
  });

  it("preserves disabled thinking for DeepSeek V4", async () => {
    const captured = await nvidiaRequest({
      model: "nvidia/deepseek-v4-flash",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "disabled" },
    });

    expect(captured.body.model).toBe("deepseek-ai/deepseek-v4-flash");
    expect(captured.body.chat_template_kwargs).toEqual({
      thinking: false,
      reasoning_effort: "none",
    });
  });

  it("routes Kimi K2.6 without DeepSeek chat-template kwargs", async () => {
    const captured = await nvidiaRequest({
      model: "nvidia/kimi-k2.6",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
      output_config: { effort: "medium" },
    });

    expect(captured.body.model).toBe("moonshotai/kimi-k2.6");
    expect(captured.body.effort).toBe("medium");
    expect(captured.body.chat_template_kwargs).toBeUndefined();
  });

  it("requires NVIDIA_API_KEY", async () => {
    delete process.env.NVIDIA_API_KEY;
    await expect(
      fetchNvidiaMessage({
        model: "nvidia/deepseek-v4-pro",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("NVIDIA_API_KEY is required");
  });
});

describe("resolveNvidiaModel", () => {
  it("accepts full upstream IDs and nvidia-prefixed IDs", () => {
    expect(resolveNvidiaModel("deepseek-ai/deepseek-v4-pro")?.id).toBe("deepseek-v4-pro");
    expect(resolveNvidiaModel("nvidia/moonshotai/kimi-k2.6")?.id).toBe("kimi-k2.6");
    expect(resolveNvidiaModel("nvidia/deepseek-v4-flash[1m]")?.id).toBe("deepseek-v4-flash");
  });
});

describe("nvidiaRequestCharLimit", () => {
  it("uses 900K for 1M models and 200K for 256K models", () => {
    expect(nvidiaRequestCharLimit("nvidia/deepseek-v4-pro")).toBe(900_000);
    expect(nvidiaRequestCharLimit("nvidia/deepseek-v4-flash[1m]")).toBe(900_000);
    expect(nvidiaRequestCharLimit("nvidia/kimi-k2.6")).toBe(200_000);
  });
});

async function nvidiaRequest(input: Parameters<typeof fetchNvidiaMessage>[0]): Promise<{
  url: string;
  authorization: string | null;
  body: Record<string, unknown>;
}> {
  process.env.NVIDIA_API_KEY = "test-nvidia-key";

  let captured:
    | {
        url: string;
        authorization: string | null;
        body: Record<string, unknown>;
      }
    | undefined;

  globalThis.fetch = (async (url, init) => {
    const headers = new Headers(init?.headers);
    captured = {
      url: String(url),
      authorization: headers.get("authorization"),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return Response.json({
      id: "chatcmpl_test",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }) as typeof fetch;

  await fetchNvidiaMessage(input);
  if (!captured) throw new Error("No request captured");
  return captured;
}

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}
