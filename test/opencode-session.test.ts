import { afterEach, expect, test } from "bun:test";
import { fetchOpenCodeMessage } from "../src/opencode";
import { openCodeClientSession, openCodeSessionId } from "../src/opencode-session";
import type { AnthropicMessageRequest } from "../src/types";
const input: AnthropicMessageRequest = { model: "opencode/mimo-v2.5-free", messages: [{ role: "user", content: "Read this source" }] };
const originalFetch = globalThis.fetch;
const originalKey = process.env.OPENCODE_API_KEY;
afterEach(() => { globalThis.fetch = originalFetch; if (originalKey === undefined) delete process.env.OPENCODE_API_KEY; else process.env.OPENCODE_API_KEY = originalKey; });
test("preserves caller conversation ID and native client headers", () => {
  const headers = new Headers({ "x-session-id": "actual-conversation-42" });
  expect(openCodeSessionId(input, openCodeClientSession(headers))).toBe("actual-conversation-42");
  headers.set("x-opencode-session", "explicit-conversation");
  expect(openCodeClientSession(headers)).toBe("explicit-conversation");
});
test("stateless fallback is stable over retries, models and continuation but separates sources", () => {
  const session = openCodeSessionId(input);
  expect(openCodeSessionId(input)).toBe(session);
  expect(openCodeSessionId({ ...input, model: "another", messages: [...input.messages!, { role: "assistant", content: "reply" }, { role: "user", content: "continue" }] })).toBe(session);
  expect(openCodeSessionId({ ...input, messages: [{ role: "user", content: "different source" }] })).not.toBe(session);
  expect(session).not.toContain("Read this source");
});
test("free Mimo request carries honest client/session routing with no auth or model change", async () => {
  delete process.env.OPENCODE_API_KEY;
  let requestHeaders: Headers | undefined;
  let model: string | undefined;
  globalThis.fetch = (async (url, init) => {
    expect(String(url)).toBe("https://opencode.ai/zen/v1/chat/completions");
    requestHeaders = new Headers(init?.headers);
    model = JSON.parse(String(init?.body)).model;
    return Response.json({id:"test",choices:[{message:{content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1}});
  }) as typeof fetch;
  await fetchOpenCodeMessage(input, { sessionId: "proklep-source-job-735335" });
  expect(requestHeaders?.get("x-opencode-session")).toBe("proklep-source-job-735335");
  expect(requestHeaders?.get("user-agent")).toBe("ai-coding-proxy/0.1.0");
  expect(requestHeaders?.get("authorization")).toBeNull();
  expect(requestHeaders?.get("x-api-key")).toBeNull();
  expect(model).toBe("mimo-v2.5-free");
});
