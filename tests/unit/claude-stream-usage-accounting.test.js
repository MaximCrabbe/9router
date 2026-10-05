// Regression: Claude streaming usage must be stored once (prompt = input + cache_read + cache_creation),
// not double-counted because the claude->openai translator mutates the shared state.usage.
import { describe, it, expect } from "vitest";
import { extractUsage, mergeUsage, canonicalizeUsage } from "../../open-sse/utils/usageTracking.js";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";

function run(chunks) {
  const state = { toolCalls: new Map(), toolCallIndex: 0, toolNameMap: null, model: "claude-opus-5-5" };
  for (const ch of chunks) {
    const ex = extractUsage(ch);
    if (ex) state.usage = mergeUsage(state.usage, ex); // stream.js transform loop
    claudeToOpenAIResponse(ch, state); // same state object
  }
  return canonicalizeUsage(state.usage); // requestDetail.saveUsageStats
}

describe("claude stream usage accounting", () => {
  it("stores the real prompt once for a cache hit", () => {
    const stored = run([
      { type: "message_start", message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 195809, cache_creation_input_tokens: 712 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 279 } },
      { type: "message_stop" },
    ]);
    expect(stored.prompt_tokens).toBe(12 + 195809 + 712);
    expect(stored.cached_tokens).toBe(195809);
    expect(stored.cache_creation_input_tokens).toBe(712);
    expect(stored.completion_tokens).toBe(279);
  });

  it("stores a first cache write once", () => {
    const stored = run([
      { type: "message_start", message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 5, output_tokens: 1, cache_creation_input_tokens: 9000 } } },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 40 } },
      { type: "message_stop" },
    ]);
    expect(stored.prompt_tokens).toBe(9005);
    expect(stored.cache_creation_input_tokens).toBe(9000);
  });
});

describe("canonicalizeUsage keeps the non-streaming and OpenAI contracts", () => {
  it("folds a cache-exclusive Claude prompt once", () => {
    expect(canonicalizeUsage({ prompt_tokens: 10, completion_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 }).prompt_tokens).toBe(115);
  });
  it("passes cache-inclusive OpenAI usage through", () => {
    const out = canonicalizeUsage({ prompt_tokens: 120, completion_tokens: 3, cached_tokens: 100 });
    expect(out.prompt_tokens).toBe(120);
    expect(out.cached_tokens).toBe(100);
  });
  it("is idempotent on its own output", () => {
    const once = canonicalizeUsage({ input_tokens: 7, output_tokens: 2, cache_read_input_tokens: 50 });
    expect(canonicalizeUsage(once)).toEqual(once);
  });
});
