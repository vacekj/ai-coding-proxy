import { collectXAIResponse } from "../src/anthropic-stream";
import {
  GROK_CLI_CLIENT_VERSION,
  apiBaseUrl,
  serverHost,
  serverPort,
  upstreamModel,
} from "../src/config";
import { loadOAuthToken } from "../src/oauth";
import type { AnthropicContentBlock, XAIOutputItem, XAIResponse } from "../src/types";
import { makeSessionId } from "../src/xai";

const expected = `composer-smoke-${crypto.randomUUID().slice(0, 8)}`;

console.log("1. Loading Grok CLI OAuth token from ~/.grok/auth.json");
const token = await loadOAuthToken();
const expiresAt = token.expires_at ? new Date(token.expires_at * 1000).toISOString() : "unknown";
console.log(`   ok: token loaded, expires ${expiresAt}`);

console.log("2. Calling Grok CLI Responses API directly");
const upstream = await fetch(`${apiBaseUrl()}/responses`, {
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
    "x-grok-conv-id": makeSessionId(),
  },
  body: JSON.stringify({
    model: upstreamModel(),
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
    stream: true,
    store: false,
    prompt_cache_key: makeSessionId(),
  }),
});
if (!upstream.ok) {
  throw new Error(`upstream failed: ${upstream.status} ${await upstream.text()}`);
}
const upstreamResponse = await collectXAIResponse(upstream);
const upstreamText = responseText(upstreamResponse);
assertExpected("upstream", upstreamText, expected);
console.log(`   ok: upstream text = ${JSON.stringify(upstreamText)}`);

console.log("3. Calling local Anthropic-compatible proxy with no auth header");
const proxyBase = process.env.SMOKE_PROXY_URL ?? `http://${serverHost()}:${serverPort()}`;
const proxy = await fetch(`${proxyBase}/v1/messages`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: upstreamModel(),
    max_tokens: 64,
    messages: [{ role: "user", content: `Reply exactly: ${expected}` }],
  }),
});
if (!proxy.ok) {
  throw new Error(`proxy failed: ${proxy.status} ${await proxy.text()}`);
}
const proxyResponse = (await proxy.json()) as {
  content?: AnthropicContentBlock[];
};
const proxyText = anthropicText(proxyResponse.content ?? []);
assertExpected("proxy", proxyText, expected);
console.log(`   ok: proxy text = ${JSON.stringify(proxyText)}`);
console.log("Smoke test passed.");

function responseText(response: XAIResponse): string {
  const parts: string[] = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const text of messageTexts(item)) parts.push(text);
  }
  return parts.join("");
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

function anthropicText(content: AnthropicContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("");
}

function assertExpected(label: string, actual: string, want: string): void {
  if (actual.trim() !== want) {
    throw new Error(`${label} response mismatch: got ${JSON.stringify(actual)}, want ${JSON.stringify(want)}`);
  }
}
