import { afterEach, describe, expect, it } from "bun:test";
import {
  clineRequestCharLimit,
  fetchClineMessage,
  isClineModel,
  resolveClineModel,
} from "../src/cline";

const originalFetch = globalThis.fetch;
const originalEnv = {
  CLINE_API_KEY: process.env.CLINE_API_KEY,
  CLINE_API_BASE: process.env.CLINE_API_BASE,
  CLINE_PROVIDERS_FILE: process.env.CLINE_PROVIDERS_FILE,
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  restoreEnv("CLINE_API_KEY");
  restoreEnv("CLINE_API_BASE");
  restoreEnv("CLINE_PROVIDERS_FILE");
});

describe("resolveClineModel / isClineModel", () => {
  it("accepts cline, clinepass, and cline-pass prefixes", () => {
    expect(resolveClineModel("cline/kimi-k3")?.id).toBe("kimi-k3");
    expect(resolveClineModel("clinepass/kimi-k3")?.id).toBe("kimi-k3");
    expect(resolveClineModel("cline-pass/kimi-k3")?.id).toBe("kimi-k3");
    expect(resolveClineModel("cline/kimi-k3[1m]")?.id).toBe("kimi-k3");
    expect(isClineModel("cline/kimi-k3")).toBe(true);
    expect(isClineModel("cline-pass/qwen3.7-max")).toBe(true);
  });

  it("does not claim bare model IDs used by other providers", () => {
    expect(isClineModel("deepseek-v4-pro")).toBe(false);
    expect(isClineModel("kimi-k2.6")).toBe(false);
    expect(isClineModel("opencode/mimo-v2.5-free")).toBe(false);
  });
});

describe("clineRequestCharLimit", () => {
  it("uses 900K for 1M models and 200K for 256K-class models", () => {
    expect(clineRequestCharLimit("cline/kimi-k3")).toBe(900_000);
    expect(clineRequestCharLimit("cline/deepseek-v4-pro")).toBe(900_000);
    expect(clineRequestCharLimit("cline/kimi-k2.7-code")).toBe(200_000);
    expect(clineRequestCharLimit("cline/mimo-v2.5")).toBe(200_000);
  });
});

describe("fetchClineMessage", () => {
  it("sends ClinePass OpenAI chat completions with API key auth", async () => {
    const captured = await clineRequest({
      model: "cline/kimi-k3",
      max_tokens: 1024,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(captured.url).toBe("https://api.cline.bot/api/v1/chat/completions");
    expect(captured.authorization).toBe("Bearer test-cline-key");
    expect(captured.body.model).toBe("cline-pass/kimi-k3");
    expect(captured.body.stream).toBe(false);
    expect(captured.body.effort).toBeUndefined();
    expect(captured.body.reasoning_effort).toBeUndefined();
    expect(captured.headers.get("x-title")).toBe("ai-coding-proxy");
  });

  it("unwraps { data, success } OAuth-style responses", async () => {
    process.env.CLINE_API_KEY = "test-cline-key";
    globalThis.fetch = (async () =>
      Response.json({
        success: true,
        data: {
          id: "gen_test",
          choices: [{ message: { content: "hello from cline" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 3, completion_tokens: 4 },
        },
      })) as unknown as typeof fetch;

    const message = await fetchClineMessage({
      model: "cline/kimi-k2.7-code",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(message.role).toBe("assistant");
    expect(message.content).toEqual([{ type: "text", text: "hello from cline" }]);
    expect(message.stop_reason).toBe("end_turn");
  });

  it("maps tool calls from OpenAI format", async () => {
    process.env.CLINE_API_KEY = "test-cline-key";
    globalThis.fetch = (async () =>
      Response.json({
        id: "chatcmpl_tools",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "Bash", arguments: '{"command":"pwd"}' },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })) as unknown as typeof fetch;

    const message = await fetchClineMessage({
      model: "cline/kimi-k3",
      max_tokens: 128,
      messages: [{ role: "user", content: "run pwd" }],
      tools: [
        {
          name: "Bash",
          description: "Run a shell command",
          input_schema: {
            type: "object",
            properties: { command: { type: "string" } },
            required: ["command"],
          },
        },
      ],
    });

    expect(message.stop_reason).toBe("tool_use");
    expect(message.content).toEqual([
      {
        type: "tool_use",
        id: "call_1",
        name: "Bash",
        input: { command: "pwd" },
      },
    ]);
  });

  it("requires CLINE_API_KEY or Cline CLI OAuth credentials", async () => {
    delete process.env.CLINE_API_KEY;
    process.env.CLINE_PROVIDERS_FILE = "/tmp/ai-coding-proxy-missing-providers.json";
    await expect(
      fetchClineMessage({
        model: "cline/kimi-k3",
        max_tokens: 16,
        messages: [{ role: "user", content: "hi" }],
      }),
    ).rejects.toThrow("ClinePass auth required");
  });

  it("refreshes expired WorkOS OAuth tokens and prefixes workos:", async () => {
    delete process.env.CLINE_API_KEY;
    const providersPath = `/tmp/ai-coding-proxy-cline-providers-${crypto.randomUUID()}.json`;
    process.env.CLINE_PROVIDERS_FILE = providersPath;

    await Bun.write(
      providersPath,
      JSON.stringify(
        {
          providers: {
            "cline-pass": {
              settings: {
                auth: {
                  accessToken: "workos:expired-token",
                  refreshToken: "refresh-abc",
                  expiresAt: Date.now() - 60_000,
                },
              },
            },
          },
        },
        null,
        2,
      ),
    );

    const calls: Array<{ url: string; body?: Record<string, unknown>; authorization: string | null }> = [];

    globalThis.fetch = (async (url, init) => {
      const headers = new Headers(init?.headers);
      const body =
        init?.body != null ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({
        url: String(url),
        body,
        authorization: headers.get("authorization"),
      });

      if (String(url).includes("/auth/refresh")) {
        return Response.json({
          success: true,
          data: {
            accessToken: "eyJhbGciOiJSUzI1NiJ9.faketoken",
            refreshToken: "refresh-xyz",
            expiresAt: "2099-01-01T00:00:00Z",
          },
        });
      }

      return Response.json({
        success: true,
        data: {
          id: "gen_oauth",
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        },
      });
    }) as typeof fetch;

    const message = await fetchClineMessage({
      model: "cline/kimi-k3",
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(message.content).toEqual([{ type: "text", text: "ok" }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe("https://api.cline.bot/api/v1/auth/refresh");
    expect(calls[0]?.body).toEqual({
      granttype: "refresh_token",
      refreshToken: "refresh-abc",
    });
    expect(calls[1]?.authorization).toBe("Bearer workos:eyJhbGciOiJSUzI1NiJ9.faketoken");

    const persisted = (await Bun.file(providersPath).json()) as {
      providers: { "cline-pass": { settings: { auth: { accessToken: string; refreshToken: string } } } };
    };
    expect(persisted.providers["cline-pass"].settings.auth.accessToken).toBe(
      "workos:eyJhbGciOiJSUzI1NiJ9.faketoken",
    );
    expect(persisted.providers["cline-pass"].settings.auth.refreshToken).toBe("refresh-xyz");

    await Bun.file(providersPath).exists().then(() => Bun.write(providersPath, ""));
  });
});

async function clineRequest(input: Parameters<typeof fetchClineMessage>[0]): Promise<{
  url: string;
  authorization: string | null;
  headers: Headers;
  body: Record<string, unknown>;
}> {
  process.env.CLINE_API_KEY = "test-cline-key";

  let captured:
    | {
        url: string;
        authorization: string | null;
        headers: Headers;
        body: Record<string, unknown>;
      }
    | undefined;

  globalThis.fetch = (async (url, init) => {
    const headers = new Headers(init?.headers);
    captured = {
      url: String(url),
      authorization: headers.get("authorization"),
      headers,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    return Response.json({
      id: "chatcmpl_test",
      choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
  }) as typeof fetch;

  await fetchClineMessage(input);
  if (!captured) throw new Error("No request captured");
  return captured;
}

function restoreEnv(name: keyof typeof originalEnv): void {
  const value = originalEnv[name];
  if (value == null) delete process.env[name];
  else process.env[name] = value;
}
