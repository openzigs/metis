---
name: ai-usage-metering-and-caching
description: Exactly-once metering of retried/dropped AI calls and prompt-cache rules per provider (#1238, #1273, #1277)
metadata:
  type: project
---

**Metering retried and dropped attempts (#1272, #1274)**
- Partial usage travels on the thrown error (`attachPartialUsage` / `partialUsageOf`, `server/src/lib/ai/partial-usage.ts`). Never surface it as an early `usage` chunk. `analysis-usage.ts`, `impact-llm-runtime.ts` and `otel/genai-spans.ts` meter every chunk they see, so an early chunk would double-bill.
- Only `AnthropicProvider.stream` attaches usage to an error. The OpenAI-compatible `chat()` (`bedrock-direct-provider.ts` `withRetry`) retries a dropped body internally, up to `AI_MAX_RETRIES`. It reports each retried attempt through `ChatOptions.onRetriedAttempt` (`retried-attempts.ts`), and every one of those reports arrives with no usage, so it is recorded as `ai.usage.unmetered`.
- `withRetriedAttemptListener` replaces any earlier listener rather than chaining to it, so the layer closest to the adapter claims the attempt. Whenever a layer replaces a "fallback if nobody listens" callback, check every caller for the hook it forwards to. `runChatToolTurn` forwarded to an optional `onUnmeteredAttempt` that discussions and `runAgent` never passed (#1274). The unreported branch now has an audit fallback. The reported branch still depends on the caller passing `onUsage`.
- ETIMEDOUT means "never reached the provider" only on connect (`syscall === "connect"` or the message says `connect ETIMEDOUT`). On an open socket it may have killed a reply that was already billed. Reuse `isProviderUnreachable` / `classifyTransportFailure`.
- An Anthropic `message_delta` usage field can be `null`. Drop nulls (`definedOnly`) before merging over `message_start`, or the input count is zeroed.
- `Analysis.totalTokens` feeds `cost-cap.ts`. See [[analysis-run-claims-and-citation-salvage]].

**Prompt caching (#1277)**
- DeepSeek caches automatically on prefixes from token 0 (64-token units, best-effort) and charges nothing for writes. Anthropic charges 1.25× for a 5-minute write and 2× for a 1-hour write. Reads cost 0.1×, or 0.05× on Sonnet/Opus 5.5. Bedrock allows 4 `cachePoint`s per request, with a 512-token floor on the 5.5 models.
- `cacheFloorTokens` must track Anthropic's and AWS's prompt-caching tables row by row. Stale floors (Sonnet 4.6 modelled at 2,048 when it is 1,024) silently turned off the docs-gen warm-up on the default model. Re-read both pages whenever a model is added.
- bedrock-access-gateway reads an absent `extra_body.prompt_caching.system` / `.messages` key as its `ENABLE_PROMPT_CACHING` default. To stop a write, send an explicit `false`, and send it only on `bedrock-gateway`.
- The waste came from per-item content sitting inside the cached prefix (grounding `messages`, gateway system prompts), not from parallel races or TTL. Top-level automatic caching puts the breakpoint on the last block, which is the per-item content here.
- The OpenAI-compatible gateway reports cache reads only, never writes, so `pnpm cache:report` savings for gateway rows are an upper bound.
- The docs-gen section prompt is a section-reuse input (`prompts` in `hashSectionInputs`). Any reorder rewrites stored sections once, and the `brd-before-1070*.json` replays must be regenerated (`WRITE_BEFORE_1070_FIXTURE=1`).

Related: [[test-falsifiability-traps]], [[reader-brd-traps]].

**Folded here (retired from the index 2026-10-21; file unchanged):** [[run-tokens-two-values-and-chat-row-is-not-the-turn]] — a run's tokens have two right values (with and without cache; name the one shown), stored totals are finish-time snapshots (use `summariseLedgerRows`, `server/src/lib/finops/ledger-usage-summary.ts`), a chat turn's ledger row is not the whole turn, and a page uses one cost definition: the stored ledger cost.

## Unknown-model fallbacks: judge by what a wrong guess costs (#1281)

Judge an unknown-model-id fallback by what a wrong guess costs (money vs latency), not by "too high is safe". A prompt-cache floor guessed too high silently skips the docs-gen warm-up and pays for parallel cache writes that are never read back.
