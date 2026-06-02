import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { collectXAIResponse } from "../src/anthropic-stream";
import {
  GROK_CLI_CLIENT_VERSION,
  apiBaseUrl,
  upstreamModel,
} from "../src/config";
import { loadOAuthToken } from "../src/oauth";
import type { AnthropicContentBlock, OAuthTokenFile, XAIOutputItem, XAIResponse } from "../src/types";
import { makeSessionId } from "../src/xai";

const TEST_TIMEOUT_MS = 90_000;
const proxyPort = Number.parseInt(process.env.LIVE_PROXY_PORT ?? "8329", 10);
const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;

let token: OAuthTokenFile;
let proxyProcess: ReturnType<typeof Bun.spawn> | undefined;

beforeAll(async () => {
  token = await loadOAuthToken();
  proxyProcess = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(proxyPort), HOST: "127.0.0.1" },
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  await waitForProxy();
}, TEST_TIMEOUT_MS);

afterAll(async () => {
  if (!proxyProcess) return;
  proxyProcess.kill("SIGTERM");
  await Promise.race([proxyProcess.exited, sleep(2_000)]);
}, 5_000);

describe("live Grok Composer proxy", () => {
  it("loads the real Grok CLI token and handles a direct upstream text response", async () => {
    expect(token.access_token.length).toBeGreaterThan(100);

    const expected = `composer-live-upstream-${crypto.randomUUID().slice(0, 8)}`;
    const response = await directXAIResponses({
      instructions: `Only answer the current user message. Do not use tools. Reply exactly: ${expected}`,
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `Reply exactly: ${expected}` }],
        },
      ],
      tools: [],
      max_output_tokens: 64,
    });

    expect(responseText(response).trim()).toBe(expected);
  }, TEST_TIMEOUT_MS);

  it("handles a real upstream Composer function_call", async () => {
    const response = await directXAIResponses({
      instructions: "Use the Shell tool exactly once to run pwd. Do not answer in prose.",
      input: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Run pwd using the Shell tool." }],
        },
      ],
      tools: [shellResponsesTool()],
      tool_choice: { type: "function", name: "Shell" },
      max_output_tokens: 128,
    });

    const call = responseFunctionCalls(response)[0];
    expect(call?.name).toBe("Shell");
    expect(String(parseToolArguments(call?.arguments).command)).toContain("pwd");
  }, TEST_TIMEOUT_MS);

  it("handles a real unauthenticated local proxy text response", async () => {
    const expected = `composer-live-proxy-${crypto.randomUUID().slice(0, 8)}`;
    const response = await proxyMessages({
      model: upstreamModel(),
      max_tokens: 64,
      messages: [{ role: "user", content: `Reply exactly: ${expected}` }],
    });

    expect(anthropicText(response.content ?? []).trim()).toBe(expected);
  }, TEST_TIMEOUT_MS);

  it("translates a real Composer tool call to Anthropic Bash and handles a real tool_result round trip", async () => {
    const first = await proxyMessages({
      model: upstreamModel(),
      max_tokens: 128,
      tool_choice: { type: "tool", name: "Bash" },
      tools: [bashAnthropicTool()],
      messages: [{ role: "user", content: "Use the Bash tool to run pwd." }],
    });

    const toolUse = anthropicToolUses(first.content ?? [])[0];
    expect(toolUse?.name).toBe("Bash");
    expect(String(toolUse?.input?.command)).toContain("pwd");

    const pwdOutput = await runRealPwd();
    expect(pwdOutput).toContain("/Users/");

    const expected = `composer-live-tool-result-${crypto.randomUUID().slice(0, 8)}`;
    const second = await proxyMessages({
      model: upstreamModel(),
      max_tokens: 96,
      tool_choice: { type: "none" },
      tools: [bashAnthropicTool()],
      messages: [
        {
          role: "user",
          content: `Use the Bash tool to run pwd, then after the result reply exactly: ${expected}`,
        },
        { role: "assistant", content: [toolUse] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUse.id, content: pwdOutput }],
        },
        { role: "user", content: `The tool result is above. Reply exactly: ${expected}` },
      ],
    });

    expect(anthropicToolUses(second.content ?? [])).toHaveLength(0);
    expect(anthropicText(second.content ?? []).trim()).toBe(expected);
  }, TEST_TIMEOUT_MS);
});

describe("live OpenCode Zen proxy", () => {
  const zenModel = process.env.LIVE_OPENCODE_MODEL ?? "opencode/minimax-m3-free";

  it("handles a real OpenCode Zen free-model text response", async () => {
    const expected = `zen-live-proxy-${crypto.randomUUID().slice(0, 8)}`;
    const response = await proxyMessages({
      model: zenModel,
      max_tokens: 64,
      messages: [{ role: "user", content: `Reply exactly: ${expected}` }],
    });

    expect(anthropicText(response.content ?? []).trim()).toBe(expected);
  }, TEST_TIMEOUT_MS);

  it("translates a real OpenCode Zen tool call and handles a real tool_result round trip", async () => {
    const first = await proxyMessages({
      model: zenModel,
      max_tokens: 128,
      tool_choice: { type: "tool", name: "Bash" },
      tools: [bashAnthropicTool()],
      messages: [{ role: "user", content: "Use the Bash tool to run pwd." }],
    });

    const toolUse = anthropicToolUses(first.content ?? [])[0];
    expect(toolUse?.name).toBe("Bash");
    expect(String(toolUse?.input?.command)).toContain("pwd");

    const pwdOutput = await runRealPwd();
    const expected = `zen-ok-${crypto.randomUUID().slice(0, 4)}`;
    const second = await proxyMessages({
      model: zenModel,
      max_tokens: 256,
      tool_choice: { type: "none" },
      tools: [bashAnthropicTool()],
      messages: [
        {
          role: "user",
          content: `Use the Bash tool to run pwd, then after the result reply exactly: ${expected}`,
        },
        { role: "assistant", content: [toolUse] },
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolUse.id, content: pwdOutput }],
        },
        { role: "user", content: `The tool result is above. Reply exactly: ${expected}` },
      ],
    });

    expect(anthropicToolUses(second.content ?? [])).toHaveLength(0);
    expect(anthropicText(second.content ?? []).trim()).toBe(expected);
  }, TEST_TIMEOUT_MS);
});

async function directXAIResponses(body: Record<string, unknown>): Promise<XAIResponse> {
  const sessionId = makeSessionId();
  const response = await fetch(`${apiBaseUrl()}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
      Authorization: `Bearer ${token.access_token}`,
      Connection: "Keep-Alive",
      "x-grok-client-identifier": "pi-grok-cli",
      "x-grok-client-version": GROK_CLI_CLIENT_VERSION,
      "x-xai-token-auth": "xai-grok-cli",
      "x-grok-model-override": upstreamModel(),
      "x-grok-conv-id": sessionId,
    },
    body: JSON.stringify({
      model: upstreamModel(),
      stream: true,
      store: false,
      prompt_cache_key: sessionId,
      ...body,
    }),
  });

  if (!response.ok) {
    throw new Error(`xAI upstream failed: ${response.status} ${await response.text()}`);
  }
  return collectXAIResponse(response);
}

async function proxyMessages(body: Record<string, unknown>): Promise<{
  content?: AnthropicContentBlock[];
  stop_reason?: string | null;
}> {
  const response = await fetch(`${proxyBaseUrl}/v1/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`proxy failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { content?: AnthropicContentBlock[]; stop_reason?: string | null };
}

function shellResponsesTool() {
  return {
    type: "function",
    name: "Shell",
    description: "Execute a shell command and return stdout, stderr, and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
      },
      required: ["command"],
    },
    strict: false,
  };
}

function bashAnthropicTool() {
  return {
    name: "Bash",
    description: "Run a shell command",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string" },
      },
      required: ["command"],
    },
  };
}

function responseText(response: XAIResponse): string {
  return (response.output ?? []).flatMap(messageTexts).join("");
}

function messageTexts(item: XAIOutputItem): string[] {
  if (item.type !== "message") return [];
  if (typeof item.content === "string") return [item.content];
  if (!Array.isArray(item.content)) return [];
  return item.content.flatMap((part) =>
    (part.type === "output_text" || part.type === "text") && typeof part.text === "string"
      ? [part.text]
      : [],
  );
}

function responseFunctionCalls(response: XAIResponse): Array<{
  type: "function_call";
  name?: string;
  arguments?: string;
}> {
  return (response.output ?? []).filter((item) => item.type === "function_call") as Array<{
    type: "function_call";
    name?: string;
    arguments?: string;
  }>;
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function anthropicText(content: AnthropicContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function anthropicToolUses(content: AnthropicContentBlock[]): Array<{
  type: "tool_use";
  id: string;
  name: string;
  input?: Record<string, unknown>;
}> {
  return content.filter((block) => block.type === "tool_use") as Array<{
    type: "tool_use";
    id: string;
    name: string;
    input?: Record<string, unknown>;
  }>;
}

async function runRealPwd(): Promise<string> {
  const proc = Bun.spawn(["pwd"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`pwd failed: ${stderr}`);
  return stdout.trim();
}

async function waitForProxy(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (proxyProcess && (await Promise.race([proxyProcess.exited.then(() => true), sleep(0).then(() => false)]))) {
      throw new Error("proxy process exited before becoming healthy");
    }
    try {
      const response = await fetch(`${proxyBaseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Keep polling until the local server is ready.
    }
    await sleep(100);
  }
  throw new Error(`proxy did not become healthy at ${proxyBaseUrl}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
