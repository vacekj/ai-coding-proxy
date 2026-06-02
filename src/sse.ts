export interface SSEMessage {
  event?: string;
  data: string;
}

export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEMessage> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index: number;
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const message = parseSSEBlock(raw);
        if (message) yield message;
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      const message = parseSSEBlock(buffer);
      if (message) yield message;
    }
  } finally {
    reader.releaseLock();
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
