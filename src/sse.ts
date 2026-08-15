export interface SSEMessage {
  event?: string;
  data: string;
}

const EVENT_BOUNDARY = /\r\n\r\n|\n\n/;

export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const cancelReader = () => {
    reader.cancel().catch(() => {});
  };

  if (signal?.aborted) {
    await cancelReader();
    return;
  }
  signal?.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      let readResult: Awaited<ReturnType<typeof reader.read>>;
      try {
        readResult = await reader.read();
      } catch {
        break;
      }
      if (readResult.done) break;
      buffer += decoder.decode(readResult.value, { stream: true });
      while (true) {
        const match = EVENT_BOUNDARY.exec(buffer);
        if (!match || match.index === undefined) break;
        const raw = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const message = parseSSEBlock(raw);
        if (message) yield message;
      }
    }
    buffer += decoder.decode();
    const message = parseSSEBlock(buffer);
    if (message) yield message;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    try {
      reader.releaseLock();
    } catch {
      // Reader already released or cancelled.
    }
  }
}

export function encodeSSE(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function parseSSEBlock(raw: string): SSEMessage | undefined {
  const data: string[] = [];
  let event: string | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return undefined;
  return { event, data: data.join("\n") };
}
