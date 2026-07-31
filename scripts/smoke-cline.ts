/**
 * Live smoke for the ClinePass provider.
 * Requires CLINE_API_KEY or `cline auth` (providers.json OAuth).
 *
 *   bun run scripts/smoke-cline.ts
 *   LIVE_CLINE_MODEL=cline/kimi-k2.7-code bun run scripts/smoke-cline.ts
 */
import { clineApiKey, clineProvidersFilePath } from "../src/config";

const proxyPort = Number.parseInt(process.env.LIVE_PROXY_PORT ?? "8331", 10);
const proxyBaseUrl = `http://127.0.0.1:${proxyPort}`;
const model = process.env.LIVE_CLINE_MODEL ?? "cline/kimi-k3";
const toolModel = process.env.LIVE_CLINE_TOOL_MODEL ?? model;
const timeoutMs = Number.parseInt(process.env.SMOKE_TIMEOUT_MS ?? "300000", 10);

async function main(): Promise<void> {
  await assertAuthAvailable();

  const proxy = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(proxyPort), HOST: "127.0.0.1" },
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });

  try {
    await waitForProxy();
    console.log(`\n== health ==`);
    const health = await (await fetch(`${proxyBaseUrl}/health`)).json();
    console.log(JSON.stringify(health, null, 2));

    console.log(`\n== models includes ClinePass ==`);
    const models = (await (await fetch(`${proxyBaseUrl}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    const clineIds = models.data.filter((m) => m.id.startsWith("cline/")).map((m) => m.id);
    console.log(clineIds.join("\n"));
    if (!clineIds.includes("cline/kimi-k3")) {
      throw new Error("cline/kimi-k3 missing from /v1/models");
    }

    console.log(`\n== text via ${model} ==`);
    const expected = `cline-smoke-${crypto.randomUUID().slice(0, 8)}`;
    const textResponse = await proxyMessages({
      model,
      max_tokens: 256,
      messages: [
        {
          role: "user",
          content: `Reply with exactly this string and nothing else: ${expected}`,
        },
      ],
    });
    const text = anthropicText(textResponse.content).trim();
    console.log("assistant:", text.slice(0, 400));
    if (!text.includes(expected)) {
      throw new Error(`expected text to include ${expected}, got: ${text}`);
    }
    console.log("text OK");

    console.log(`\n== tool call via ${toolModel} ==`);
    const first = await proxyMessages({
      model: toolModel,
      max_tokens: 1024,
      tool_choice: { type: "auto" },
      tools: [bashTool()],
      messages: [
        {
          role: "user",
          content:
            "You must call the Bash tool exactly once with command pwd. Do not answer in prose before the tool call.",
        },
      ],
    });
    const toolUse = anthropicToolUses(first.content)[0];
    console.log("stop_reason:", first.stop_reason);
    console.log("tool_use:", JSON.stringify(toolUse));
    if (!toolUse || toolUse.name !== "Bash") {
      throw new Error(`expected Bash tool_use, got: ${JSON.stringify(first.content).slice(0, 500)}`);
    }
    if (!String(toolUse.input?.command ?? "").includes("pwd")) {
      throw new Error(`expected pwd command, got: ${JSON.stringify(toolUse.input)}`);
    }

    const pwd = (await Bun.$`pwd`.text()).trim();
    const marker = `cline-tool-${crypto.randomUUID().slice(0, 6)}`;
    const second = await proxyMessages({
      model: toolModel,
      max_tokens: 1024,
      tools: [bashTool()],
      messages: [
        {
          role: "user",
          content: "Call Bash with pwd, then after the result reply with the marker I provide.",
        },
        { role: "assistant", content: [toolUse] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: toolUse.id, content: pwd },
            { type: "text", text: `Tool finished. Reply exactly: ${marker}` },
          ],
        },
      ],
    });
    const secondText = anthropicText(second.content).trim();
    console.log("after tool_result:", secondText.slice(0, 400));
    if (anthropicToolUses(second.content).length > 0) {
      throw new Error("expected no further tool calls after tool_result");
    }
    if (!secondText.includes(marker)) {
      throw new Error(`expected marker ${marker}, got: ${secondText}`);
    }
    console.log("\nClinePass smoke passed.");
  } finally {
    proxy.kill("SIGTERM");
    await Promise.race([proxy.exited, sleep(2_000)]);
  }
}

async function assertAuthAvailable(): Promise<void> {
  if (clineApiKey()) {
    console.log("Using CLINE_API_KEY");
    return;
  }
  const path = clineProvidersFilePath();
  if (await Bun.file(path).exists()) {
    console.log(`Using Cline CLI OAuth from ${path}`);
    return;
  }
  throw new Error("No Cline auth: set CLINE_API_KEY or run `cline auth`");
}

async function proxyMessages(body: Record<string, unknown>): Promise<{
  content: Array<Record<string, unknown>>;
  stop_reason?: string | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${proxyBaseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`proxy ${response.status}: ${text.slice(0, 800)}`);
    }
    return JSON.parse(text) as {
      content: Array<Record<string, unknown>>;
      stop_reason?: string | null;
    };
  } finally {
    clearTimeout(timer);
  }
}

function bashTool() {
  return {
    name: "Bash",
    description: "Run a shell command",
    input_schema: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
    },
  };
}

function anthropicText(content: Array<Record<string, unknown>>): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("");
}

function anthropicToolUses(content: Array<Record<string, unknown>>): Array<{
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

async function waitForProxy(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${proxyBaseUrl}/health`);
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await sleep(100);
  }
  throw new Error(`proxy did not become healthy at ${proxyBaseUrl}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
