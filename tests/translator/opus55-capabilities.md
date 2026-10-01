# Opus 5.5 capability evidence — v0.5.86, ported to v0.5.95

Sections up to "Caveats" record the original fix (de1f6c96, base v0.5.86). Where the
v0.5.95 port changed behavior for other models, "Port naar v0.5.95" below supersedes them.

## Official sources (read 2026-09-23)

- [Launch announcement](https://www.anthropic.com/claude-opus-5-5): thinking cannot be switched off; benchmarks use adaptive thinking and effort.
- [Exact model API contract](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5): `claude-opus-5-5` is always adaptive. Omit `thinking` or send `{"type":"adaptive"}` (equivalent); `disabled` and manual `enabled` budgets return 400.
- [Exact model feature support](https://platform.claude.com/docs/en/models/opus-5-5/whats-new-opus-5-5#feature-support) explicitly includes [PDF support](https://platform.claude.com/docs/en/build-with-claude/pdf-support). The exact capability entry includes `pdf: true` because exact lookup bypasses synced catalog enrichment.
- [Effort documentation](https://platform.claude.com/docs/en/build-with-claude/effort): Opus 5.5 supports `low`, `medium`, `high`, `xhigh`, `max` via `output_config.effort`.

**Default:** the exact model page explicitly says, “A request that omits `effort` runs at `medium`; on Claude Opus 5 it ran at `high`.” The general effort page fetched on this date also names this exception. This is model-specific evidence, not an inference from benchmark labels or a recommendation. The exact entry advertises `thinkingEffortDefault: "medium"`; `auto` and translated adaptive-without-effort resolve to it. Omitted intent and valid native adaptive-without-effort remain omitted, leaving the same upstream default in charge. Other models keep legacy `auto → high` handling.

## Resolution and wire path

1. `providers/capabilities.js`: provider override → canonical exact ID (vendor prefix stripped) → first matching pattern → defaults. Previously the broad `*claude*opus-5*` pattern inherited `thinkingCanDisable: true` and `thinkingEffortSupported: false`. The exact entry corrects these while retaining existing vision/PDF/search/tools and 1M/128K limits. Other IDs/defaults retain their contracts.
2. `providers/thinkingLevels.js`: exact bare/vendor-prefixed Opus 5.5 IDs expose all five levels, removing `none` using the capability flag. No broader Opus pattern is changed.
3. `translator/index.js`: capture intent before translation; `output_config.effort` takes precedence over OpenAI `reasoning_effort`/Responses `reasoning.effort`, then `thinking`. `thinkingUnified.applyThinking` reapplies it after translation, with model suffixes taking priority. Adaptive `xhigh` now survives when the model's level set supports it; other adaptive models retain their old mapping.
4. Always-on Claude omits the redundant `thinking` switch unless the client requested valid `display: "omitted"` or `"summarized"`; then it retains `{type: "adaptive", display}` on both native and translated paths, including `auto` and `none` normalization. Disable attempts retain the established clamp-instead-of-disable policy, but on effort-capable Opus 5.5 use its lowest supported level (`low`, not the undocumented legacy `minimal`). Manual budgets become effort rather than an illegal `enabled` request.
5. `chatCore.js` normally calls the translator, strips the routing suffix, then dispatches. Claude Code native passthrough instead calls `normalizeClaudePassthrough`; its narrow capability-gated guard now normalizes disable/manual intent and explicit `auto` using the same shared clamp/default. Valid native payloads and unrelated `output_config` fields survive.
6. Claude uses `DefaultExecutor` → `BaseExecutor.execute` → `JSON.stringify` → `proxyAwareFetch`. Tests run real translator/preparation or native normalization and this executor, asserting the JSON at the mocked transport boundary, not just intermediate capability objects. No real provider call or credential is used.

## Checks

Run from the worktree root (local Vitest 4.1.11, Node 22.23.2):

```sh
node tests/node_modules/vitest/vitest.mjs run --config tests/vitest.config.js tests/translator/opus55-capabilities.test.js --reporter=dot

node tests/node_modules/vitest/vitest.mjs run --config tests/vitest.config.js tests/translator/opus55-capabilities.test.js tests/translator/thinking-unified.test.js tests/translator/agent-client-fixes.test.js tests/unit/capabilities.test.js tests/unit/capabilities-opus-context.test.js tests/unit/combo-capabilities.test.js tests/unit/thinking-effort-openai-max-clamp.test.js tests/unit/thinking-budget-max-level.test.js tests/unit/thinking-levels-gpt56-sol.test.js tests/unit/thinking-levels-kiro.test.js tests/unit/provider-thinking-config.test.js tests/unit/claude-foreign-server-tool-use.test.js tests/unit/claude-cache-budget-single-object.test.js --reporter=dot

node node_modules/eslint/bin/eslint.js open-sse/providers/capabilities.js open-sse/providers/thinkingLevels.js open-sse/translator/concerns/thinkingUnified.js open-sse/translator/formats/claude.js tests/translator/opus55-capabilities.test.js
git diff --check
```

- Focused suite: 121 passed. Metadata (including PDF for bare/vendor-prefixed IDs), all five efforts across OpenAI translation/Anthropic same-format/native paths, disable inputs, manual budgets, suffix precedence, omitted versus auto effort, and older-model payload regressions. Added display coverage for `omitted`/`summarized` on native and same-format translated paths, including `auto`, `none`, manual budgets, and Fable's existing effort mappings; invalid display does not add an adaptive switch. The new display/PDF assertions reproduced the regressions before the fix.
- Regression selection: 301 passed, one **pre-existing** failure: `thinking-unified.test.js` → `GLM-5.2 also gets reasoning_effort (supported from 5.2 onward)`. The same failure occurred before production edits (115 passed, one failed in the baseline selection below) and was reproduced before this display/PDF follow-up. GLM's exact entry masks its pattern's effort flag; unrelated to Opus 5.5.
- Targeted ESLint and whitespace checks passed. Full build/full suite not run.

Baseline command (run before production edits):

```sh
node tests/node_modules/vitest/vitest.mjs run --config tests/vitest.config.js tests/unit/capabilities.test.js tests/unit/capabilities-opus-context.test.js tests/translator/thinking-unified.test.js tests/unit/thinking-effort-openai-max-clamp.test.js tests/unit/thinking-budget-max-level.test.js --reporter=dot
```

Dependencies were installed locally with scripts/audit disabled and cache inside `tests/node_modules`; no manifests or lockfiles changed. npm required `--legacy-peer-deps`; ESLint additionally required a local `--no-save typescript@5` install.

## Caveats

Native model-suffix processing remains as before (chatCore strips it without applying it for Claude native passthrough). Tests exercise its actual normalization helper and executor, rather than the complete HTTP/chatCore orchestration. Live API acceptance, account-specific behavior, and unrelated Opus 5.5 features such as forced tools/preserved thinking are not tested here.

## Port naar v0.5.95

The intent of de1f6c96 was re-applied by hand to upstream tag v0.5.95, not cherry-picked. Upstream wins for every model other than the exact Anthropic `claude-opus-5-5` ID.

### Upstream changes that touch the same code

| Commit | Upstream change | Effect on the port |
|---|---|---|
| 7894f3d3 | Gives every claude-adaptive model xhigh in its thinking levels, and makes xhigh conditional in `applyFormat` (clamped only when the model doesn't support it) | Same xhigh gate the port needed. Kept as-is; Opus 5.5 relies on it. |
| 90b06934 | `captureThinking` infers `display:"summarized"` for OpenAI Chat `reasoning_effort` / Responses `reasoning.summary`; `applyThinking` carries it to the adaptive switch | Conflicts with "always-on models get no switch". Fixed with the `bodyDisplay` split (see below). |
| ccd0677d, 49ba54b2 | Sonnet 5.x resolves to claude-adaptive; Sonnet 5.5 added (`thinkingOffType`, `prepareClaudeRequest`, `normalizeClaudePassthrough` changes) | Not touched. Step 0 of the port runs only when canDisable is false and effort is supported, which matches no Sonnet entry. |
| e78b766a | Kiro `claude-opus-5.5*` dotted IDs and a global `claude-opus-5.5` capability entry | Kept. The port's exact entry is keyed on the dashed Anthropic ID only, so Kiro and Token Harbor (`claude-opus-5.5`) keep upstream behavior. |
| 1b72f02e | opencode-go deepseek `max` → `high` clamp in `thinkingLevels`/`thinkingUnified` | Unrelated code paths. No conflict. |

### Re-applied changes, per file

- `open-sse/providers/capabilities.js`: exact `claude-opus-5-5` entry in `MODEL_CAPABILITIES` (claude-adaptive, `thinkingCanDisable:false`, `thinkingEffortSupported:true`, `thinkingEffortDefault:"medium"`, vision/pdf/search, 1M/128K). Updated the comment on `DEFAULT_CAPABILITIES.thinkingEffortSupported`. Also added `codex` → `gpt-6.1-sol` (see "GPT-6.1 Sol").
- `open-sse/providers/thinkingLevels.js`: `claude-opus-5-5` and `*/claude-opus-5-5` first in `PATTERN_THINKING`, giving `L.budgetX`. `none` is removed through the capability flag.
- `open-sse/translator/concerns/thinkingUnified.js` (claude-adaptive branch):
  1. minimal → lowest supported level, only when `thinkingEffortSupported`.
  2. auto → `thinkingEffortDefault`, else the legacy `high`.
  3. xhigh → high only when xhigh is missing from the supported levels (7894f3d3 gate).
- `open-sse/translator/formats/claude.js`: step 0 in `normalizeClaudePassthrough`, with the same logic as de1f6c96. Disabled/enabled/auto intent on permanently adaptive effort models goes through `applyThinking`. Valid native requests stay lossless.

### Decision: explicit vs inferred display

`applyThinking` now tracks two values:

- `bodyDisplay`: only the explicit `body.thinking.display`.
- `display`: the explicit value, else the one 90b06934 infers for OpenAI clients.

Models that can disable thinking still get `{type:"adaptive", display}` exactly as upstream does. Permanently adaptive models (Fable 5.1, Opus 5.5) only get `{type:"adaptive", display}` when the client explicitly set `"omitted"` or `"summarized"`. The inferred display is not added for them.

Why: this keeps upstream's Fable behavior (no switch) and the original Opus 5.5 contract (OpenAI auto leaves `thinking` undefined). Consequence: for OpenAI clients on Opus 5.5 and Fable, `selectAnthropicBeta` keeps `redact-thinking-2026-02-12`, because it only drops it when `thinking.display === "summarized"`.

### Changed test expectations (other models only, upstream behavior)

Opus 5.5 expectations were not changed or weakened.

1. `keeps the prior contract for %s` is now a table with levels per model:
   - `claude-opus-5`, `-5-50`, `-5-5-preview` and `-4-7` now include `xhigh` (7894f3d3).
   - `claude-sonnet-4-6` stays without `xhigh` (7894f3d3 keeps the `*claude*4-6*` override).
2. `%s keeps xhigh → high normalization` was renamed to `%s keeps upstream xhigh gating`:
   - opus-5, opus-4-7 and fable → `xhigh`; sonnet-4-6 → `high` (7894f3d3).
   - For non-Fable models, `thinking` is now `{type:"adaptive", display:"summarized"}` for this OpenAI-client input (90b06934).
3. Haiku budget thinking is now `{type:"enabled", budget_tokens:24576, display:"summarized"}` (90b06934).

### Added tests

- `Kiro %s keeps its upstream (e78b766a) contract` for `claude-opus-5.5`, `-thinking`, `-agentic` and `-thinking-agentic`:
  - levels `none/low/medium/high/xhigh/max`
  - `thinkingCanDisable:true`, `thinkingEffortSupported:false`, no default
- `OpenAI-inferred display (%s, upstream 90b06934)…` for Chat `reasoning_effort:"high"` and Responses `reasoning:{effort:"high",summary:"auto"}`:
  - Opus 5 gets `{type:"adaptive", display:"summarized"}`.
  - Opus 5.5 gets no `thinking` and `output_config:{effort:"high"}`.

### GPT-6.1 Sol

`unit/codex-gpt6-lite.test.js` was 16/17 on unmodified v0.5.95. The failing case was `lists gpt-6.1-sol with Codex capabilities`: it expected a 272000 context window and got 1050000.

Cause:

- dec820b9 added the model and the test, but no `PROVIDER_CAPABILITIES.codex` entry.
- 89ffac5a then raised the `*gpt-6*` pattern to 1.05M, and its comment says Codex OAuth's truncation belongs in `PROVIDER_CAPABILITIES`.

Fix: a `gpt-6.1-sol` entry that mirrors `gpt-6-sol`. The file is now 17/17.

### Commands and results (run from `tests/`, Vitest 4.1.11)

```sh
npx vitest run translator/opus55-capabilities.test.js
npx vitest run unit/codex-gpt6-lite.test.js
npx vitest run --reporter=json --outputFile=<report.json>    # full suite, before and after
node __baseline__/verify-no-regression.mjs <report with paths rewritten to /app/>
node __baseline__/verify-providers.mjs; node __baseline__/verify-alias.mjs; node __baseline__/verify-oauth-urls.mjs
node node_modules/eslint/bin/eslint.js <4 source files> tests/translator/opus55-capabilities.test.js   # from the worktree root
git diff --check
```

- **opus55-capabilities:** 127/127 pass (121 original + 6 added). Before the port: 39/121.
- **codex-gpt6-lite:** 17/17 (16/17 before).
- **Focused set** (21 files: thinking, capabilities, Claude/Sonnet 5.5/Kiro Opus 5.5/Token Harbor, translator helpers, golden-request, codex-gpt6-lite): 376/378. Both failures are pre-existing on v0.5.95:
  - `thinking-unified` → `GLM-5.2 also gets reasoning_effort`
  - `translator-helpers-edge` → `normalizeClaudePassthrough … hoists mid-conversation system messages`
- **Full suite:**

  | Run | Tests | Passed | Failed | Failing entries (incl. suite errors) |
  |---|---|---|---|---|
  | Before (v0.5.95 source + this test file) | 3279 | 2997 | 183 | 189, 82 of them opus55 |
  | After | 3285 | 3086 | 100 | 106, 0 in opus55 / codex-gpt6-lite |

  A sorted `comm` of the failure lists shows **0 new failures**.
- **Flaky test:** one full run had two failures in `unit/xai-oauth-service.test.js` (5 s timeout, then an unconsumed fetch mock). That file passes 3/3 in isolation and in the next full run. It touches no ported code.
- **verify-no-regression** reads `/app/` paths, so the paths in the report were rewritten first.
  - Before: 169 entries (87 excluding opus55).
  - After: 86 entries, the same pre-existing failures minus the fixed codex case. None are new; they are just missing from `known-fails.txt`.
- **verify-providers** exits 1 with identical output before and after: `codex.headers` 0.155.0 → 0.159.0, from upstream ca6e8407 (baseline snapshot not refreshed).
- **verify-alias** and **verify-oauth-urls** pass.
- **ESLint** and `git diff --check` are clean.
- A full run creates an untracked `translator/__snapshots__/golden-url-header.test.js.snap`. It was deleted after each run.

### Still open

- No live Anthropic acceptance test.
- Native model-suffix handling is unchanged (see Caveats).
- Kiro and Token Harbor dotted Opus 5.5 IDs keep the upstream contract (`thinkingCanDisable:true`, no effort default). If Kiro forwards to the real always-adaptive model, its disable path needs a separate decision.
