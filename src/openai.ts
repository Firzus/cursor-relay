import { randomUUID } from "node:crypto";

/** Shared helpers for building OpenAI `chat.completion.chunk` SSE output. */

export function newCompletionId(): string {
  return "chatcmpl-" + randomUUID().replace(/-/g, "").slice(0, 24);
}

export interface ChunkDelta {
  role?: "assistant";
  content?: string;
  reasoning_content?: string;
  tool_calls?: unknown[];
}

export function chatChunk(
  id: string,
  model: string,
  created: number,
  delta: ChunkDelta,
  finishReason: string | null = null,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

/** Flatten OpenAI chat message content (string or content-part array) to text. */
export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .filter(Boolean)
      .join("");
  }
  return "";
}

export const SSE_DONE = "data: [DONE]\n\n";

export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream",
  // `no-transform` forbids intermediaries (the Cloudflare edge, any buffering
  // proxy) from compressing or rewriting the body; `x-accel-buffering: no`
  // disables proxy-level response buffering. Together they keep streamed tokens
  // from being clumped before they reach Cursor. See issue #30.
  "cache-control": "no-cache, no-transform",
  "x-accel-buffering": "no",
  connection: "keep-alive",
};

/** A minimal OpenAI SSE stream that emits `text` then stops. Used by stubs/errors. */
export function openAiTextStream(model: string, text: string): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const id = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(enc.encode(sse(chatChunk(id, model, created, { role: "assistant" }))));
      c.enqueue(enc.encode(sse(chatChunk(id, model, created, { content: text }))));
      c.enqueue(enc.encode(sse(chatChunk(id, model, created, {}, "stop"))));
      c.enqueue(enc.encode(SSE_DONE));
      c.close();
    },
  });
}
