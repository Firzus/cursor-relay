import { test, expect } from "bun:test";
import { SSE_HEADERS } from "./openai.ts";

// Both the normal and error stream paths in dispatch.ts build their Response
// from this single SSE_HEADERS constant, so pinning it here covers both. See #30.
test("SSE headers tell intermediaries to leave the token stream untouched", () => {
  expect(SSE_HEADERS["content-type"]).toBe("text/event-stream");
  // no-transform forbids edge compression/rewriting; x-accel-buffering disables
  // proxy buffering — together they keep streamed tokens from being clumped.
  expect(SSE_HEADERS["cache-control"]).toBe("no-cache, no-transform");
  expect(SSE_HEADERS["x-accel-buffering"]).toBe("no");
});
