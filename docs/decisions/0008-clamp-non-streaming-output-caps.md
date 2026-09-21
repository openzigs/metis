# 0008 — Clamp non-streaming output caps rather than moving the calls to `stream()`

- **Status:** Accepted
- **Date:** 2026-08-06
- **Issue:** [#1257](https://github.com/openzigs/metis-private/issues/1257)
- **Supersedes nothing.** Extends #1221's model-ceiling clamp, which does not
  cover this case.

## Context

Two facts, both measured live in #1223.

**Thinking spends the output cap.** `claude-sonnet-5` emits extended thinking by
default — METIS sends no `thinking` field and `output_tokens_details.thinking_tokens`
comes back populated anyway — and those tokens are drawn from the same
`max_tokens` budget as the answer. Five identical synthesis calls at a 16,000
cap spent 5,088 / 7,708 / 8,308 / 9,763 on thinking, against a JSON payload of
~5–6k tokens. Two of the five hit `max_tokens`. A cap sized against the expected
answer is sized against roughly half of what the request consumes, and the
fraction moves run to run.

**The Anthropic SDK refuses non-streaming requests above 21,333.**
`Client#calculateNonstreamingTimeout` throws client-side, before any network
call, when `60min × max_tokens / 128_000 > 10min`. Measured on
`@anthropic-ai/sdk` 0.104.2: 21,333 accepted, 21,334 throws. `AnthropicProvider.chat()`
is non-streaming and builds its client with no `timeout`, so the guard is live.

**There is a second, lower throw condition the issue did not name.** The
adversarial panel found it: `Messages.create` also passes
`MODEL_NONSTREAMING_TOKENS[body.model]` into the same function, and it throws
when `max_tokens` exceeds that per-model entry — **8,192** for eight
`claude-opus-4*` ids. `ANTHROPIC_MODEL` is an unconstrained string, so those ids
are reachable, and a guard that clamped only to 21,333 would have reported a
clean 21,000 on a request that still threw. The effective bound is the minimum
of the two. That table is not in the package's `exports` map, so it is mirrored
in `nonstreaming-output-bound.ts` and pinned twice: byte-for-byte against the
SDK's own file read off disk, and behaviourally per id with **both** arguments —
calling `calculateNonstreamingTimeout` with one argument silently skips this
condition, which is exactly how the first version of these tests missed it.

`MODEL_MAX_OUTPUT_TOKENS` (#1221) lists `claude-sonnet-5` at 128,000, so
`clampToModelOutputCeiling` is a literal no-op for it. Both numbers are right
about different things — model capability versus an SDK timeout heuristic — but
the clamp *reads* as the guard against oversized output requests and is not one
for any non-streaming call. Three `chat()` call sites (claim extractor,
faithfulness judge, discovery agent) already resolve 32,768 and were therefore
over the bound before this issue.

## Decision

**Clamp. Do not move `chat()` call sites to `stream()`.** Enforcement lives at
two levels:

1. **`AnthropicProvider.chat()` bounds `max_tokens` unconditionally.** This is
   the chokepoint every non-streaming call passes through, so it covers call
   sites resolved by knobs the AI layer has never heard of — including
   docs-gen's 32,768 section cap — rather than relying on each to remember.
2. **`clampToModelOutputCeiling` accepts the transport** so the *resolution*
   layer reports the same number and its warning names the caller's own knob.
   The bound is reported in a separate `sdkNonStreamingBound` field, never
   collapsed into `ceiling`: collapsing them is how the clamp came to read as a
   guard on a path it did not cover.

The bound is derived from the three constants the SDK combines, and pinned
against the installed SDK — `n` accepted, `n + 1` throws, in general and per
model — in `server/src/lib/ai/nonstreaming-output-bound.test.ts`. An SDK bump
that moves the formula, or edits the per-model table, fails a 20 ms unit test
instead of a live run.

The per-model lookup matches the outgoing id **exactly**, as the SDK does. That
is why `AnthropicProvider.chat()` is the enforcement point: it holds the
normalised id actually placed on the wire, whereas a cap resolver upstream may
still be holding a Bedrock-style spelling the SDK's table does not name. The
resolution-layer check is best-effort and exists so the warning names the
operator's own knob.

The bound applies to the `anthropic` provider key only. `bedrock-gateway`
reaches the same models through the AWS SDK, which has no such heuristic;
clamping it would be an over-block on a cap deliberately raised for it (#1226).

## Why not `stream()`

- **`chat()` is a different contract.** It returns one `Promise<ChatResponse>`;
  its callers parse, validate, retry, repair and count tokens against that shape,
  several with `responseFormat` and structured-output fallbacks. Converting them
  would be a large behavioural change across the analysis and docs-gen pipelines.
- **It would buy nothing that is currently wanted.** No cap in the repo needs
  more than 21,333 output tokens once thinking is accounted for. Synthesis, the
  largest, is 21,000. The change would be paid now for headroom nobody uses.
- **The SDK's constraint is not merely bureaucratic.** A non-streaming HTTP
  response held open for more than ten minutes is what load balancers and
  proxies drop. Raising past the bound is not obviously safe just because the
  client stopped objecting; it moves a clean client-side error to a dirtier
  network-layer one.
- **The escape hatch stays open.** `stream()` is deliberately *not* bounded, it
  already forwards `stop_reason` (#1224), and the clamp's warning says so. A
  future call site that genuinely needs a larger output budget streams — which is
  the same decision, made with a reason rather than by accident.

## Consequences

- Three docs-gen `chat()` call sites are now held at 21,333 on the `anthropic`
  provider instead of throwing client-side, and keep 32,768 on Bedrock.
- `TokenUsage` carries `thinkingTokens`, and `AnthropicProvider` logs the output
  budget per call — at WARN when the cap was reached, which is the exact
  signature of the #1223 failure and previously took a live reproduction to see.
  (`thinkingTokens` is allowlisted in `TOKEN_COUNT_META_KEYS`; a `/token/i` key
  is `[REDACTED]` unless named there, #1263.)
- The per-call-site verdict against a 9,763-token thinking run lives in
  `server/tests/output-cap-sweep.test.ts`, computed from the production
  resolvers so it fails when a cap moves. One entry does **not** survive that
  run — Phase-1 facts extraction at 8,192 — and is named there rather than
  quietly omitted. It streams, so it cannot hit the SDK bound; raising it needs
  its own measurement, not a guess.
- If a future model's ceiling drops below 21,333, the model clamp still wins:
  the effective value is the lowest of the three.
- Deployments setting `ANTHROPIC_MODEL` to `claude-opus-4-0`, `claude-opus-4-1-20250805`
  or one of their six aliases are now clamped to 8,192 on `chat()` rather than
  failing. That is a real reduction in output budget for those ids, and it is the
  SDK's number, not ours — the alternative is a hard client-side throw.
