/**
 * #1257 scope item 3 — sweep every OUTPUT cap that landed in the #1217→#1228 arc
 * against the two facts #1223 measured, and keep the verdict from going stale.
 *
 * | # | call site | transport | resolved cap | ≤ SDK bound? | survives a 9,763-token think? |
 * |---|-----------|-----------|-------------:|--------------|-------------------------------|
 * | #1224 | `runAgent` final answer | `chat` | 16,384 | yes | yes — 6,621 left for the payload |
 * | #1218 | agent-loop final-answer retry | `chat` | 16,384 | yes | yes — same cap, same budget |
 * | #1218 | salvage repair (`× 1.25`) | `chat` | 20,480 | yes | yes — 10,717 left |
 * | #1223 | synthesis | `chat` | 21,000 | yes | yes — 11,237 left, vs 6,237 at the old 16,000 |
 * | #1226 | Phase-1 facts extraction | `stream` | 8,192 | n/a | **no** — a 9,763 think exhausts it outright |
 * | #1226 | Phase-2 section synthesis | `stream` | 32,768 | n/a — streaming is unbounded | yes |
 * | #1227 | claim extractor | `chat` | 32,768 | **NO — clamped to 21,333** | yes |
 * | #1227 | faithfulness judge | `chat` | 32,768 | **NO — clamped to 21,333** | yes |
 * | #1228 | db-schema prose batch | `chat` | 16,384 | yes | yes — 6,621 left for ~30 descriptions |
 * | #1228 | discovery agent | `chat` | 32,768 | **NO — clamped to 21,333** | yes |
 *
 * The three `chat` sites resolving 32,768 were over the SDK's non-streaming
 * bound BEFORE this issue: on the `anthropic` provider those calls threw
 * client-side, before any network call, and #1221's clamp reported nothing
 * because `claude-sonnet-5` is listed at 128,000. They are held at 21,333 by the
 * provider-boundary guard rather than by a change to each cap, so the value
 * stays 32,768 on Bedrock, where it was deliberately chosen and no such limit
 * exists.
 *
 * The Phase-1 facts cap is the one entry that does NOT survive the worst
 * measured think. It streams, so it cannot hit the SDK bound, and it runs on a
 * cheap extraction model that may not think at all — but the arithmetic is real
 * and stated rather than quietly omitted, and its `finishReason` is already
 * checked at the call site (#1226). Raising it is out of scope here: it needs
 * its own measurement, not a guess.
 *
 * Every number below is READ FROM THE PRODUCTION RESOLVER, not restated. A table
 * of literals in a comment is what goes stale; this file fails when one moves.
 *
 * `CALL_SITES` has eight entries to the table's ten: the agent-loop final-answer
 * retry and `runAgent` share `resolveFinalAnswerMaxOutputTokens` (deliberately —
 * "one agent answer, one cap", #1218), and the claim extractor and faithfulness
 * judge share `resolveSectionMaxOutputTokens`. Sweeping the same resolver twice
 * would inflate the count without testing anything new.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { __resetConfigSingleton } from "../src/lib/config/config-service.js";
import {
  ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS,
  OBSERVED_THINKING_TOKENS,
  boundNonStreamingOutputTokens,
  survivesObservedThinkingRun,
  __resetNonStreamingBoundWarnings,
} from "../src/lib/ai/nonstreaming-output-bound.js";
import { __resetOutputCeilingWarnings } from "../src/lib/ai/model-output-limits.js";
import { DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS } from "../src/lib/analysis/agent-loop.js";
import {
  repairMaxOutputTokens,
  resolveFinalAnswerMaxOutputTokens,
} from "../src/lib/analysis/agent-runner.js";
import { resolveSynthesisMaxOutputTokens } from "../src/lib/analysis/synthesis.js";
import {
  resolveDbSchemaProseMaxOutputTokens,
  resolveFactsMaxOutputTokens,
  resolveSectionMaxOutputTokens,
} from "../src/lib/docs-gen/output-caps.js";

/** The model the measurements in #1223 were taken on. */
const MODEL = "claude-sonnet-5";

interface CallSite {
  issue: string;
  name: string;
  /** `chat` is non-streaming and therefore subject to the SDK bound. */
  transport: "chat" | "stream";
  /** The cap the production resolver returns for {@link MODEL}. */
  resolve: () => number;
  /** Rough size of the answer this call has to fit, in tokens. */
  payloadTokens: number;
  /** Whether the cap is expected to clear payload + the worst measured think. */
  survivesWorstThink: boolean;
}

const CALL_SITES: readonly CallSite[] = [
  {
    issue: "#1224",
    name: "runAgent final answer",
    transport: "chat",
    resolve: () => resolveFinalAnswerMaxOutputTokens(MODEL),
    payloadTokens: 6_000,
    survivesWorstThink: true,
  },
  {
    issue: "#1218",
    name: "salvage repair (base × 1.25)",
    transport: "chat",
    resolve: () => repairMaxOutputTokens(DEFAULT_FINAL_ANSWER_MAX_OUTPUT_TOKENS, MODEL),
    payloadTokens: 6_000,
    survivesWorstThink: true,
  },
  {
    issue: "#1223",
    name: "synthesis",
    transport: "chat",
    resolve: () => resolveSynthesisMaxOutputTokens(MODEL),
    payloadTokens: 6_500,
    survivesWorstThink: true,
  },
  {
    issue: "#1226",
    name: "Phase-1 facts extraction",
    transport: "stream",
    resolve: () => resolveFactsMaxOutputTokens(MODEL),
    payloadTokens: 4_000,
    // The one entry that does not clear it. Stated, not hidden.
    survivesWorstThink: false,
  },
  {
    issue: "#1226",
    name: "Phase-2 section synthesis",
    transport: "stream",
    resolve: () => resolveSectionMaxOutputTokens(MODEL),
    payloadTokens: 8_000,
    survivesWorstThink: true,
  },
  {
    issue: "#1227",
    name: "claim extractor / faithfulness judge",
    transport: "chat",
    resolve: () => resolveSectionMaxOutputTokens(MODEL),
    payloadTokens: 8_000,
    survivesWorstThink: true,
  },
  {
    issue: "#1228",
    name: "db-schema prose batch",
    transport: "chat",
    resolve: () => resolveDbSchemaProseMaxOutputTokens(MODEL),
    payloadTokens: 6_000,
    survivesWorstThink: true,
  },
  {
    issue: "#1228",
    name: "discovery agent",
    transport: "chat",
    resolve: () => resolveSectionMaxOutputTokens(MODEL),
    payloadTokens: 4_000,
    survivesWorstThink: true,
  },
];

beforeEach(() => {
  __resetConfigSingleton();
  __resetOutputCeilingWarnings();
  __resetNonStreamingBoundWarnings();
});

describe("#1257 — the week's caps, swept against the SDK bound", () => {
  it("finds every call site the sweep claims to cover", () => {
    // Anti-vacuity: an empty or shrunken table would pass every case below.
    expect(CALL_SITES.length).toBe(8);
    expect(CALL_SITES.filter((c) => c.transport === "chat").length).toBe(6);
  });

  it.each(CALL_SITES.filter((c) => c.transport === "chat"))(
    "$issue $name — what reaches the anthropic provider is within the SDK bound",
    ({ resolve }) => {
      const effective = boundNonStreamingOutputTokens(resolve(), "anthropic").value;
      expect(effective).toBeLessThanOrEqual(ANTHROPIC_NONSTREAMING_MAX_OUTPUT_TOKENS);
    },
  );

  it("the guard is LOAD-BEARING — at least one site is genuinely clamped", () => {
    // Without this the case above passes trivially if every cap already fits,
    // and the sweep would be decoration. Three sites resolve 32,768 today.
    const clamped = CALL_SITES.filter(
      (c) =>
        c.transport === "chat" && boundNonStreamingOutputTokens(c.resolve(), "anthropic").clamped,
    );
    expect(clamped.map((c) => c.name)).toContain("claim extractor / faithfulness judge");
    expect(clamped.length).toBeGreaterThanOrEqual(2);
  });

  it("leaves the SAME caps alone on a provider with no such bound", () => {
    for (const site of CALL_SITES) {
      const raw = site.resolve();
      expect(boundNonStreamingOutputTokens(raw, "bedrock-gateway").value, site.name).toBe(raw);
    }
  });
});

describe("#1257 — the week's caps, swept against a 9,763-token thinking run", () => {
  it.each(CALL_SITES)(
    "$issue $name — verdict against the worst measured think",
    ({ resolve, payloadTokens, survivesWorstThink, transport }) => {
      // The cap a call actually gets is the bounded one on the chat path.
      const effective =
        transport === "chat"
          ? boundNonStreamingOutputTokens(resolve(), "anthropic").value
          : resolve();
      expect(survivesObservedThinkingRun(effective, payloadTokens)).toBe(survivesWorstThink);
    },
  );

  it("names the one site that does NOT survive, so it cannot be lost", () => {
    const failing = CALL_SITES.filter((c) => !c.survivesWorstThink).map((c) => c.name);
    expect(failing).toEqual(["Phase-1 facts extraction"]);
  });

  it("records the 16,000 cap #1223 replaced as one that did not survive either", () => {
    // The historical baseline, kept as a fixed point: whatever else moves, the
    // reason synthesis was raised must stay legible.
    expect(survivesObservedThinkingRun(16_000, 6_500)).toBe(false);
    expect(OBSERVED_THINKING_TOKENS.max).toBe(9_763);
  });
});
