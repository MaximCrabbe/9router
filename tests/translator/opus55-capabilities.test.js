import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./registerAll.js";
import { getCapabilitiesForModel } from "../../open-sse/providers/capabilities.js";
import { getThinkingLevels } from "../../open-sse/providers/thinkingLevels.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { normalizeClaudePassthrough } from "../../open-sse/translator/formats/claude.js";
import { stripThinkingSuffix } from "../../open-sse/translator/concerns/thinkingUnified.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";

// Exercise real translation/preparation and executor serialization, stopping at
// the transport boundary. No credentials, network, or persistent state required.
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch: vi.fn() }));

const MODEL = "claude-opus-5-5";
const LEVELS = ["low", "medium", "high", "xhigh", "max"];
const routes = [
  { name: "OpenAI translation", source: "openai" },
  { name: "Anthropic same-format translation", source: "claude" },
  { name: "Claude native passthrough", source: "claude", native: true },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  proxyAwareFetch.mockImplementation(async () => new Response("{}", {
    status: 200, headers: { "content-type": "application/json" },
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function emit(route, fields = {}, model = MODEL) {
  const body = {
    model,
    messages: [{ role: "user", content: "Hello" }],
    max_tokens: 4096,
    stream: false,
    ...structuredClone(fields),
  };
  const translated = route.native
    ? normalizeClaudePassthrough(body, model)
    : translateRequest(route.source, "claude", model, body, false, {}, "claude");
  // chatCore strips the routing suffix before dispatching the upstream body.
  translated.model = stripThinkingSuffix(model);
  const result = await new DefaultExecutor("claude").execute({
    model: stripThinkingSuffix(model), body: translated, stream: false, credentials: {},
  });
  expect(result.response.ok).toBe(true);
  expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  const [url, options] = proxyAwareFetch.mock.calls[0];
  expect(url).toBe("https://api.anthropic.com/v1/messages?beta=true");
  expect(options.method).toBe("POST");
  const sent = JSON.parse(options.body);
  expect(sent.model).toBe(stripThinkingSuffix(model));
  expect(sent.reasoning_effort).toBeUndefined();
  expect(sent.enable_thinking).toBeUndefined();
  return sent;
}

describe("Opus 5.5 exact capability metadata", () => {
  it.each([null, "claude", "cc", "openrouter"])("resolves the contract for provider %s", (provider) => {
    for (const model of [MODEL, `anthropic/${MODEL}`]) {
      expect(getCapabilitiesForModel(provider, model)).toMatchObject({
        vision: true, pdf: true, reasoning: true, search: true, tools: true,
        thinkingFormat: "claude-adaptive", thinkingCanDisable: false,
        thinkingEffortSupported: true, thinkingEffortDefault: "medium", contextWindow: 1000000, maxOutput: 128000,
      });
      expect(getThinkingLevels(provider, model)).toEqual(LEVELS);
    }
  });

  it.each(["claude-opus-5", "claude-opus-5-50", "claude-opus-5-5-preview", "claude-opus-4-7", "claude-sonnet-4-6"])(
    "keeps the prior contract for %s", (model) => {
      expect(getCapabilitiesForModel("claude", model)).toMatchObject({
        thinkingCanDisable: true, thinkingEffortSupported: false,
      });
      expect(getCapabilitiesForModel("claude", model).thinkingEffortDefault).toBeUndefined();
      expect(getThinkingLevels("claude", model)).toEqual(["none", "low", "medium", "high", "max"]);
    }
  );
});

describe.each(routes)("$name → serialized Anthropic request", (route) => {
  it.each(LEVELS)("preserves explicit %s effort", async (effort) => {
    const fields = route.source === "openai"
      ? { reasoning_effort: effort }
      : { thinking: { type: "adaptive" }, output_config: { effort } };
    const sent = await emit(route, fields);
    expect(sent.output_config).toEqual({ effort });
    // For permanently adaptive models, omission is equivalent to adaptive.
    expect(sent.thinking === undefined || sent.thinking.type === "adaptive").toBe(true);
    expect(sent.thinking?.budget_tokens).toBeUndefined();
  });

  it.each([
    ["reasoning none", { reasoning_effort: "none" }],
    ["reasoning off", { reasoning_effort: "off" }],
    ["disabled thinking", { thinking: { type: "disabled" } }],
    ["effort none", { output_config: { effort: "none" } }],
    ["effort off", { output_config: { effort: "off" } }],
    ["boolean disable", { enable_thinking: false }],
  ])("clamps %s to the lowest supported effort while staying adaptive", async (_name, fields) => {
    const sent = await emit(route, fields);
    expect(sent.output_config).toEqual({ effort: "low" });
    expect(sent.thinking).toBeUndefined();
  });

  it("leaves omitted effort to the upstream default", async () => {
    const sent = await emit(route);
    expect(sent.output_config).toBeUndefined();
    expect(sent.thinking).toBeUndefined();
  });

  it.each([
    ["OpenAI auto", { reasoning_effort: "auto" }],
    ["Anthropic auto", { output_config: { effort: "auto" } }],
  ])("resolves %s to the exact-model medium default", async (_name, fields) => {
    const sent = await emit(route, fields);
    expect(sent.output_config).toEqual({ effort: "medium" });
    expect(sent.thinking).toBeUndefined();
  });

  if (route.source === "claude") {
    describe.each(["omitted", "summarized"])("thinking.display=%s", (display) => {
      it.each([
        ["auto effort", { output_config: { effort: "auto" } }, "medium"],
        ["none effort", { output_config: { effort: "none" } }, "low"],
        ["low effort", { output_config: { effort: "low" } }, "low"],
        ["medium effort", { output_config: { effort: "medium" } }, "medium"],
        ["xhigh effort", { output_config: { effort: "xhigh" } }, "xhigh"],
        ["OpenAI auto", { reasoning_effort: "auto" }, "medium"],
        ["OpenAI none", { reasoning_effort: "none" }, "low"],
        ["manual budget", { thinking: { type: "enabled", budget_tokens: 8192 } }, "medium"],
        ["disabled thinking", { thinking: { type: "disabled" } }, "low"],
      ])("preserves display when normalizing %s", async (_name, fields, effort) => {
        const sent = await emit(route, {
          ...fields,
          thinking: { ...(fields.thinking || { type: "adaptive" }), display },
        });
        expect(sent.thinking).toEqual({ type: "adaptive", display });
        expect(sent.output_config).toEqual({ effort });
      });
    });

    it.each(["", "invalid"])("does not retain invalid display %j when normalizing auto", async (display) => {
      const sent = await emit(route, { thinking: { type: "adaptive", display }, output_config: { effort: "auto" } });
      expect(sent.thinking).toBeUndefined();
      expect(sent.output_config).toEqual({ effort: "medium" });
    });
  }

  if (!route.native) {
    it("resolves adaptive without effort to the exact-model medium default", async () => {
      const fields = { thinking: { type: "adaptive" } };
      const sent = await emit(route, fields);
      expect(sent.output_config).toEqual({ effort: "medium" });
      expect(sent.thinking).toBeUndefined();
    });

    it.each(["none", "off", "xhigh"])("honors the %s routing suffix over body effort", async (suffix) => {
      const sent = await emit(route, { output_config: { effort: "max" } }, `${MODEL}(${suffix})`);
      expect(sent.output_config).toEqual({ effort: suffix === "xhigh" ? "xhigh" : "low" });
      expect(sent.thinking).toBeUndefined();
    });
  } else {
    it("keeps native adaptive without effort delegated to upstream", async () => {
      const sent = await emit(route, { thinking: { type: "adaptive", display: "summarized" } });
      expect(sent.output_config).toBeUndefined();
      expect(sent.thinking).toEqual({ type: "adaptive", display: "summarized" });
    });

    it("keeps unrelated native output_config fields when clamping", async () => {
      const format = { type: "json_schema", schema: { type: "object", properties: {} } };
      const sent = await emit(route, { thinking: { type: "disabled" }, output_config: { format } });
      expect(sent.output_config).toEqual({ format, effort: "low" });
      expect(sent.thinking).toBeUndefined();
    });
  }

  it("converts a manual budget to effort without emitting enabled thinking", async () => {
    const sent = await emit(route, { thinking: { type: "enabled", budget_tokens: 8192 } });
    expect(sent.output_config).toEqual({ effort: "medium" });
    expect(sent.thinking).toBeUndefined();
  });

  it("gives explicit effort priority over a thinking disable attempt", async () => {
    const sent = await emit(route, { thinking: { type: "disabled" }, output_config: { effort: "max" } });
    expect(sent.output_config).toEqual({ effort: "max" });
    expect(sent.thinking).toBeUndefined();
  });
});

describe("existing Claude emitted-payload regressions", () => {
  describe.each(["omitted", "summarized"])("always-on Fable display=%s", (display) => {
    it.each([["auto", "high"], ["none", "minimal"]])("keeps display and the existing %s effort mapping", async (input, effort) => {
      const sent = await emit(routes[1], {
        thinking: { type: "adaptive", display }, output_config: { effort: input },
      }, "claude-fable-5-1");
      expect(sent.thinking).toEqual({ type: "adaptive", display });
      expect(sent.output_config).toEqual({ effort });
    });
  });

  it.each(["claude-opus-5", "claude-opus-4-7", "claude-sonnet-4-6", "claude-fable-5-1"])(
    "%s keeps auto → high normalization", async (model) => {
      const sent = await emit(routes[0], { reasoning_effort: "auto" }, model);
      expect(sent.output_config).toEqual({ effort: "high" });
      expect(getCapabilitiesForModel("claude", model).thinkingEffortDefault).toBeUndefined();
    }
  );

  it.each(["claude-opus-5", "claude-opus-4-7", "claude-sonnet-4-6", "claude-fable-5-1"])(
    "%s keeps xhigh → high normalization", async (model) => {
      const sent = await emit(routes[0], { reasoning_effort: "xhigh" }, model);
      expect(sent.output_config).toEqual({ effort: "high" });
      expect(sent.thinking).toEqual(model === "claude-fable-5-1" ? undefined : { type: "adaptive" });
    }
  );

  it("Opus 5 can still disable thinking", async () => {
    const sent = await emit(routes[0], { reasoning_effort: "none" }, "claude-opus-5");
    expect(sent.thinking).toEqual({ type: "disabled" });
    expect(sent.output_config).toBeUndefined();
  });

  it("Haiku still uses budget thinking", async () => {
    const sent = await emit(routes[0], { reasoning_effort: "high" }, "claude-haiku-4-5-20251001");
    expect(sent.thinking).toEqual({ type: "enabled", budget_tokens: 24576 });
    expect(sent.output_config).toBeUndefined();
  });
});
