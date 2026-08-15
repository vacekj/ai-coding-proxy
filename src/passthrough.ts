import { streamPingMs } from "./config";
import { encodeSSE, parseSSE } from "./sse";
import { isRecord } from "./util";
import { errorPayload } from "./openai-compat";

export class UpstreamError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

export async function postJSON(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
  errorLabel: string,
): Promise<Response> {
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal,
  });

  if (!response.ok) {
    throw new UpstreamError(
      response.status,
      `${errorLabel} upstream error ${response.status}: ${await response.text()}`,
    );
  }

  return response;
}

export function anySignal(...signals: Array<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener("abort", () => controller.abort(), { once: true });
  }
  return controller.signal;
}

interface StreamRelayOptions {
  signal?: AbortSignal;
  abort?: () => void;
}

export function anthropicSSEToAnthropicSSE(
  upstreamPromise: Promise<Response>,
  clientModel: string,
  options: StreamRelayOptions = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let pingInterval: ReturnType<typeof setInterval> | undefined;
  let done = false;

  const clearPings = () => {
    if (pingInterval !== undefined) {
      clearInterval(pingInterval);
      pingInterval = undefined;
    }
  };

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        if (done) return;
        try {
          controller.enqueue(encoder.encode(encodeSSE(event, data)));
        } catch {
          finish();
        }
      };
      const finish = () => {
        done = true;
        clearPings();
        options.abort?.();
        try {
          controller.close();
        } catch {
          // Stream already closed (consumer disconnected or cancelled).
        }
      };

      pingInterval = setInterval(() => send("ping", { type: "ping" }), streamPingMs());

      let response: Response;
      try {
        response = await upstreamPromise;
      } catch (error) {
        send("error", errorPayload(error));
        finish();
        return;
      }

      const body = response.body;
      if (!body) {
        send("error", { type: "error", error: { type: "api_error", message: "upstream returned an empty body" } });
        finish();
        return;
      }

      try {
        for await (const message of parseSSE(body, options.signal)) {
          if (!message.data) continue;
          let data: unknown = message.data;
          try {
            data = JSON.parse(message.data);
          } catch {
            // Forward non-JSON payloads verbatim.
          }
          if (isRecord(data) && data.type === "message_start" && isRecord(data.message)) {
            data.message.model = clientModel;
          }
          send(message.event ?? "message", data);
          if (isRecord(data) && data.type === "message_stop") break;
        }
      } catch (error) {
        send("error", errorPayload(error));
        finish();
        return;
      }

      finish();
    },
    cancel() {
      done = true;
      clearPings();
      options.abort?.();
    },
  });
}
