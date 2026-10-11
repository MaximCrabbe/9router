// Anthropic keepalive pings across the OpenAI pivot.
//
// Opus 5.5 at high effort can think for minutes. With redacted/omitted thinking (or
// long gaps between summary deltas) Anthropic sends only `ping` events, about every
// 30s. claude-to-openai used to drop them, so an OpenAI-format client (Hermes) saw
// no chunk at all for minutes and aborted the stream as stale mid-thought.
// The ping now travels as a choiceless chunk: liveness without content.
import { describe, it, expect } from "vitest";
import { claudeToOpenAIResponse } from "../../open-sse/translator/response/claude-to-openai.js";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { createSSETransformStreamWithLogger } from "../../open-sse/utils/stream.js";

const START = { type: "message_start", message: { id: "msg_ka", model: "claude-opus-5-5", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } };
const PING = { type: "ping" };
const THINK_START = { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } };
const SIG = { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig_x" } };
const THINK_STOP = { type: "content_block_stop", index: 0 };
const TEXT_START = { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } };
const TEXT = { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } };
const TEXT_STOP = { type: "content_block_stop", index: 1 };
const MSG_DELTA = { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } };
const MSG_STOP = { type: "message_stop" };

// Redacted thinking: minutes of pings, then the answer.
const redactedThinkingStream = [START, THINK_START, PING, PING, PING, SIG, THINK_STOP, TEXT_START, TEXT, TEXT_STOP, MSG_DELTA, MSG_STOP];

function translateAll(events) {
  const state = { toolCalls: new Map(), toolCallIndex: 0 };
  return events.map((ev) => claudeToOpenAIResponse(ev, state));
}

function sseStream(events) {
  const encoder = new TextEncoder();
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
}

async function drain(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += typeof value === "string" ? value : decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function dataFrames(text) {
  return text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => l.slice(6).trim());
}

describe("claude-to-openai: ping keepalive", () => {
  it("turns each ping into a choiceless chunk carrying the message id", () => {
    const out = translateAll(redactedThinkingStream);
    const pings = out.filter((_, i) => redactedThinkingStream[i] === PING);
    expect(pings).toHaveLength(3);
    for (const r of pings) {
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ id: "chatcmpl-msg_ka", object: "chat.completion.chunk", model: "claude-opus-5-5", choices: [] });
      expect(r[0].usage).toBeUndefined();
    }
  });

  it("emits nothing for a ping before message_start or after the finish chunk", () => {
    const state = { toolCalls: new Map(), toolCallIndex: 0 };
    expect(claudeToOpenAIResponse(PING, state)).toBeNull();
    for (const ev of [START, TEXT_START, TEXT, TEXT_STOP, MSG_DELTA]) claudeToOpenAIResponse(ev, state);
    expect(state.finishReasonSent).toBe(true);
    expect(claudeToOpenAIResponse(PING, state)).toBeNull();
  });

  it("does not change content, reasoning or finish of the translated answer", () => {
    const deltas = translateAll(redactedThinkingStream).flat().filter(Boolean).flatMap((c) => c.choices.map((ch) => ch));
    expect(deltas.map((ch) => ch.delta?.content || "").join("")).toBe("Done.");
    expect(deltas.map((ch) => ch.delta?.reasoning_content || "").join("")).toBe("");
    expect(deltas.filter((ch) => ch.finish_reason).map((ch) => ch.finish_reason)).toEqual(["stop"]);
  });
});

describe("SSE stream to an OpenAI client: pings reach the wire", () => {
  it("forwards one keepalive frame per upstream ping between role and answer", async () => {
    const out = sseStream(redactedThinkingStream).pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI, "claude", null, null, "claude-opus-5-5"),
    );
    const frames = dataFrames(await drain(out));
    const chunks = frames.filter((f) => f !== "[DONE]").map((f) => JSON.parse(f));
    const keepalives = chunks.filter((c) => Array.isArray(c.choices) && c.choices.length === 0 && !c.usage);
    expect(keepalives).toHaveLength(3);
    // Order: role chunk first, keepalives before the answer text.
    expect(chunks[0].choices[0].delta.role).toBe("assistant");
    const firstText = chunks.findIndex((c) => c.choices?.[0]?.delta?.content);
    const lastKeepalive = chunks.lastIndexOf(keepalives.at(-1));
    expect(lastKeepalive).toBeLessThan(firstText);
    expect(chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("")).toBe("Done.");
  });

  it("keeps Responses-API clients unaffected (keepalive yields no extra events)", async () => {
    const withPings = await drain(sseStream(redactedThinkingStream).pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "claude", null, null, "claude-opus-5-5"),
    ));
    const withoutPings = await drain(sseStream(redactedThinkingStream.filter((e) => e !== PING)).pipeThrough(
      createSSETransformStreamWithLogger(FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES, "claude", null, null, "claude-opus-5-5"),
    ));
    const types = (t) => t.split("\n").filter((l) => l.startsWith("event: ")).map((l) => l.slice(7));
    expect(types(withPings)).toEqual(types(withoutPings));
  });
});
