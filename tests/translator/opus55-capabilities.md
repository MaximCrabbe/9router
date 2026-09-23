# Opus 5.5 capability evidence — v0.5.86

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
