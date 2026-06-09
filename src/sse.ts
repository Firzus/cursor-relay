/**
 * Generic SSE (text/event-stream) parsing, shared by the provider translators.
 * Splits a byte stream into event blocks and a block into its event/data
 * fields; interpreting the data payload stays provider-specific.
 */

const LINE_SPLIT = /\r?\n/;

/** Split a raw SSE byte stream into event blocks (separated by blank lines). */
export async function* sseBlocks(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        yield buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
      }
    }
    if (buffer) yield buffer;
  } finally {
    reader.releaseLock();
  }
}

export interface SSEEvent {
  /** SSE `event:` field; defaults to "message" per the spec. */
  event: string;
  /** Joined `data:` lines, not yet JSON-parsed. */
  data: string;
}

/** Extract the event name and raw data payload from one SSE block. */
export function parseSSEEvent(block: string): SSEEvent | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(LINE_SPLIT)) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}
