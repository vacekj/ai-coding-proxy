import {
  GROK_CLI_CLIENT_VERSION,
  apiBaseUrl,
  upstreamModel,
} from "./config";
import { loadOAuthToken } from "./oauth";
import type { ResponsesContentPart, ResponsesInputItem, ResponsesRequest } from "./types";
import type { TranslationResult } from "./translate";

export interface XAIRequestOptions {
  sessionId?: string;
  signal?: AbortSignal;
}

export async function fetchXAIResponses(
  translation: TranslationResult,
  options: XAIRequestOptions = {},
): Promise<Response> {
  const token = await loadOAuthToken();
  const sessionId = options.sessionId ?? makeSessionId();
  const body = sanitizeResponsesRequest({
    ...translation.request,
    model: upstreamModel(),
    stream: true,
    store: false,
    prompt_cache_key: translation.request.prompt_cache_key ?? sessionId,
  });

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
    body: JSON.stringify(body),
    signal: options.signal,
  });

  if (!response.ok) {
    throw new Error(`xAI upstream error ${response.status}: ${await response.text()}`);
  }

  return response;
}

export function makeSessionId(seed?: string): string {
  if (seed?.trim()) return seed.trim();
  return `claude-proxy-${crypto.randomUUID()}`;
}

function sanitizeResponsesRequest(request: ResponsesRequest): ResponsesRequest {
  const next: ResponsesRequest = {
    ...request,
    input: sanitizeInput(request.input),
    tools: normalizeTools(request.tools ?? []),
  };

  delete next.prompt_cache_retention;
  delete next.previous_response_id;
  delete next.safety_identifier;
  delete next.stream_options;

  if (next.tools && next.tools.length === 0) {
    next.tools = [];
    delete next.tool_choice;
  }

  if (next.response_format && !next.text) {
    next.text = { format: next.response_format };
    delete next.response_format;
  }

  return next;
}

function sanitizeInput(input: ResponsesInputItem[]): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];

  for (const item of input) {
    if (item.type === "reasoning") {
      continue;
    }

    if (item.type === "message") {
      const content = item.content
        .filter((part) => part.type !== "input_text" || part.text.length > 0)
        .map((part) =>
          part.type === "input_image" && !("detail" in part)
            ? ({ ...part, detail: "auto" } as ResponsesContentPart)
            : part,
        );
      if (content.length > 0) out.push({ ...item, content });
      continue;
    }

    if (item.type === "function_call_output" && Array.isArray(item.output)) {
      const textParts: string[] = [];
      const imageParts: ResponsesContentPart[] = [];
      for (const part of item.output) {
        if (part.type === "input_image") imageParts.push(part);
        else if ("text" in part && typeof part.text === "string") textParts.push(part.text);
      }
      out.push({
        ...item,
        output: textParts.join("\n") || "(tool returned no text output)",
      });
      if (imageParts.length > 0) {
        out.push({
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text: `The previous tool result (${item.call_id}) included ${imageParts.length} image(s). Use the attached image(s) as that tool output.`,
            },
            ...imageParts,
          ],
        });
      }
      continue;
    }

    out.push(item);
  }

  return out;
}

function normalizeTools(tools: ResponsesRequest["tools"]): ResponsesRequest["tools"] {
  const normalized: ResponsesRequest["tools"] = [];
  for (const tool of tools ?? []) {
    if (tool.type === "function" && !tool.parameters) {
      normalized.push({ ...tool, parameters: { type: "object", properties: {} } });
      continue;
    }
    normalized.push(tool);
  }
  return normalized;
}
