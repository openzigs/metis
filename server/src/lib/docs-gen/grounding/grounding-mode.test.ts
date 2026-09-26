/**
 * DOCS_GEN_GROUNDING — mode resolution and the deterministic passage sampler.
 * Stub extractor/judge; no network, no database, no live model.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const logSpy = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock("../../logger.js", () => ({ createChildLogger: () => logSpy }));

import type { ConfigService } from "../../config/config-service.js";
import { getKeyDef } from "../../config/key-registry.js";
import type { ClaimDecomposition } from "./claim-extractor.js";
import { isPartialSample, summarizeFaithfulness } from "./citation-validator.js";
import type { GroundingContext } from "./grounding-context.js";
import type { ClaimVerdict } from "./faithfulness-judge.js";
import {
  DEFAULT_GROUNDING_SAMPLE_RATE,
  FULL_GROUNDING,
  GROUNDING_SAMPLE_MIN_CLAIMS,
  groundingPolicyRecord,
  renderSampledPassages,
  resolveGroundingPolicy,
  sampleDrawOrder,
  scoreFaithfulnessSampled,
  scoreUnderPolicy,
  splitSamplePassages,
} from "./grounding-mode.js";

function config(values: Record<string, string> = {}): Pick<ConfigService, "get"> {
  return { get: (key: string) => values[key] };
}

const CTX = {
  sources: [{ sourceId: "rag:doc:0", kind: "rag", label: "doc", text: "evidence" }],
  sourceIds: new Set(["rag:doc:0"]),
  isEmpty: false,
} as unknown as GroundingContext;

/** A section of `n` passages, two statement lines each, a heading every 5. */
function section(n: number, tag = "S"): string {
  const parts = ["## Section"];
  for (let i = 0; i < n; i++) {
    if (i % 5 === 0) parts.push(`### Topic ${i / 5}`);
    parts.push(
      `Claim ${tag}${i}a holds whenever the configured policy applies to the request.\n` +
        `Claim ${tag}${i}b also holds for every request that is validated.`,
    );
  }
  return parts.join("\n\n");
}

/** Stub extractor (one claim per "Claim" line) and judge (supports all but `*b`). */
function deps() {
  const decomposed: string[] = [];
  const judged: string[][] = [];
  return {
    decomposed,
    judged,
    deps: {
      extractor: {
        decompose: vi.fn(async (text: string): Promise<ClaimDecomposition> => {
          decomposed.push(text);
          return {
            claims: text
              .split("\n")
              .filter((l) => l.startsWith("Claim "))
              .map((claim) => ({ claim, sourceIds: [] })),
          };
        }),
      },
      judge: {
        judge: vi.fn(async (claims: string[]): Promise<ClaimVerdict[]> => {
          judged.push(claims);
          return claims.map((claim) => ({ claim, supported: !/\db /.test(claim), sourceIds: [] }));
        }),
      },
    },
  };
}

beforeEach(() => {
  logSpy.warn.mockReset();
});

// ── Resolution ────────────────────────────────────────────────────────────

describe("resolveGroundingPolicy", () => {
  it("defaults to `on` (full check) when unset, without a warning", () => {
    expect(resolveGroundingPolicy(config())).toBe(FULL_GROUNDING);
    expect(FULL_GROUNDING.mode).toBe("on");
    expect(logSpy.warn).not.toHaveBeenCalled();
  });

  it("accepts on / sample / off, case-insensitively", () => {
    expect(resolveGroundingPolicy(config({ DOCS_GEN_GROUNDING: "on" })).mode).toBe("on");
    expect(resolveGroundingPolicy(config({ DOCS_GEN_GROUNDING: " OFF " })).mode).toBe("off");
    const sample = resolveGroundingPolicy(config({ DOCS_GEN_GROUNDING: "Sample" }));
    expect(sample).toEqual({
      mode: "sample",
      sampleRate: DEFAULT_GROUNDING_SAMPLE_RATE,
      minClaims: GROUNDING_SAMPLE_MIN_CLAIMS,
    });
    expect(DEFAULT_GROUNDING_SAMPLE_RATE).toBe(0.25);
    expect(GROUNDING_SAMPLE_MIN_CLAIMS).toBe(10);
  });

  it("falls back to `on` with a warning for an unrecognised mode — never to a weaker check", () => {
    for (const bad of ["partial", "false", "0", "sampled"]) {
      logSpy.warn.mockReset();
      expect(resolveGroundingPolicy(config({ DOCS_GEN_GROUNDING: bad }))).toBe(FULL_GROUNDING);
      expect(logSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining("Invalid DOCS_GEN_GROUNDING"),
        expect.anything(),
      );
    }
  });

  it("reads the sample rate, and falls back to 0.25 with a warning when it is out of (0, 1]", () => {
    const rate = (r: string) =>
      resolveGroundingPolicy(
        config({ DOCS_GEN_GROUNDING: "sample", DOCS_GEN_GROUNDING_SAMPLE_RATE: r }),
      ).sampleRate;
    expect(rate("0.5")).toBe(0.5);
    expect(rate("1")).toBe(1);
    for (const bad of ["0", "-0.1", "1.5", "abc", "NaN"]) {
      logSpy.warn.mockReset();
      expect(rate(bad)).toBe(0.25);
      expect(logSpy.warn).toHaveBeenCalledWith(
        expect.stringContaining("Invalid DOCS_GEN_GROUNDING_SAMPLE_RATE"),
        expect.anything(),
      );
    }
  });

  it("is registered as runtime tunables whose schemas reject bad writes", () => {
    const mode = getKeyDef("DOCS_GEN_GROUNDING")!;
    expect(mode.tier).toBe("tunable");
    expect(mode.schema.safeParse("sample").success).toBe(true);
    expect(mode.schema.safeParse("partial").success).toBe(false);
    const rate = getKeyDef("DOCS_GEN_GROUNDING_SAMPLE_RATE")!;
    expect(rate.schema.safeParse("0.25").success).toBe(true);
    expect(rate.schema.safeParse("0").success).toBe(false);
    expect(rate.schema.safeParse("1.01").success).toBe(false);
  });

  it("records nothing for `on`, the mode for `off`, the mode and rate for `sample`", () => {
    expect(groundingPolicyRecord(FULL_GROUNDING)).toBeUndefined();
    expect(groundingPolicyRecord({ ...FULL_GROUNDING, mode: "off" })).toEqual({ mode: "off" });
    expect(groundingPolicyRecord({ mode: "sample", sampleRate: 0.4, minClaims: 10 })).toEqual({
      mode: "sample",
      sampleRate: 0.4,
      minClaims: 10,
    });
  });
});

// ── Passages and the draw ─────────────────────────────────────────────────

describe("splitSamplePassages", () => {
  it("makes heading-only blocks the context of the passages under them, and keeps fences whole", () => {
    const md = "## S\n\n### A\n\nOne.\n\nTwo.\n\n### B\nThree.\n\n```\nx\n\ny\n```\n\nFour.";
    const passages = splitSamplePassages(md);
    expect(passages.map((p) => [p.text, p.heading])).toEqual([
      ["One.", "### A"],
      ["Two.", "### A"],
      ["### B\nThree.", null],
      ["```\nx\n\ny\n```", "### B"],
      ["Four.", "### B"],
    ]);
  });

  it("renders drawn passages in section order, each heading once", () => {
    const passages = splitSamplePassages(section(10));
    const text = renderSampledPassages(passages, [7, 1, 2]);
    expect(text.split("\n\n")).toEqual([
      "### Topic 0",
      passages[1].text,
      passages[2].text,
      "### Topic 1",
      passages[7].text,
    ]);
  });
});

describe("sampleDrawOrder", () => {
  const passages = splitSamplePassages(section(40));

  it("draws ceil(n × rate) passages in round 0, one from each evenly spaced stratum", () => {
    const [first] = sampleDrawOrder(passages, 0.25);
    expect(first).toHaveLength(10);
    first.forEach((i, j) => {
      expect(i).toBeGreaterThanOrEqual(j * 4);
      expect(i).toBeLessThan((j + 1) * 4);
    });
    // Not simply the first N passages.
    expect(first).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("is deterministic and seeded from the passage text", () => {
    expect(sampleDrawOrder(passages, 0.25)).toEqual(sampleDrawOrder(passages, 0.25));
    // Different text → a different draw (here, the other tag changes every hash).
    const other = splitSamplePassages(section(40, "T"));
    expect(sampleDrawOrder(other, 0.25)[0]).not.toEqual(sampleDrawOrder(passages, 0.25)[0]);
  });

  it("covers every passage exactly once across its rounds", () => {
    const all = sampleDrawOrder(passages, 0.3).flat();
    expect([...all].sort((a, b) => a - b)).toEqual(passages.map((p) => p.index));
  });

  it("returns nothing for no passages", () => {
    expect(sampleDrawOrder([], 0.25)).toEqual([]);
  });
});

// ── Sampled scoring ───────────────────────────────────────────────────────

describe("scoreFaithfulnessSampled", () => {
  it("judges ONLY the claims of the sampled passages, from one decomposition call", async () => {
    const d = deps();
    const md = section(80);
    const result = await scoreFaithfulnessSampled("S", md, CTX, d.deps, {
      rate: 0.25,
      minClaims: 10,
    });
    expect(d.decomposed).toHaveLength(1);
    expect(d.judged).toHaveLength(1);
    const sampledClaims = d.decomposed[0].split("\n").filter((l) => l.startsWith("Claim "));
    expect(d.judged[0]).toEqual(sampledClaims);
    expect(sampledClaims).toHaveLength(40); // 20 of 80 passages × 2
    expect(result.totalClaims).toBe(40);
    expect(result.faithfulness).toBe(0.5);
    expect(result.sampled).toMatchObject({ rate: 0.25, passagesChecked: 20, passagesTotal: 80 });
    expect(isPartialSample(result)).toBe(true);
    expect(summarizeFaithfulness(result)).toContain("SAMPLED: 20/80 passages checked");
  });

  it("draws the same claims on a re-run", async () => {
    const a = deps();
    const b = deps();
    await scoreFaithfulnessSampled("S", section(60), CTX, a.deps, { rate: 0.25, minClaims: 10 });
    await scoreFaithfulnessSampled("S", section(60), CTX, b.deps, { rate: 0.25, minClaims: 10 });
    expect(b.judged).toEqual(a.judged);
  });

  it("spreads the sample across the whole section", async () => {
    const d = deps();
    await scoreFaithfulnessSampled("S", section(80), CTX, d.deps, { rate: 0.25, minClaims: 10 });
    const idx = d.judged[0].map((c) => Number(/Claim S(\d+)/.exec(c)![1]));
    expect(Math.min(...idx)).toBeLessThan(4);
    expect(Math.max(...idx)).toBeGreaterThanOrEqual(76);
  });

  it("tops a sparse sample up to the claim minimum", async () => {
    // Long passages with ONE claim each: the first draw falls short of 10.
    const md = Array.from(
      { length: 40 },
      (_, i) => `Claim S${i}a holds.\n${"filler prose without claims ".repeat(20)}`,
    ).join("\n\n");
    const d = deps();
    const result = await scoreFaithfulnessSampled("S", md, CTX, d.deps, {
      rate: 0.1,
      minClaims: 10,
    });
    expect(d.judged[0].length).toBeGreaterThanOrEqual(10);
    expect(d.decomposed.length).toBeGreaterThan(1);
    expect(isPartialSample(result)).toBe(true);
  });

  it("checks a section with fewer claims than the minimum in full, and does not call it sampled", async () => {
    const md = section(4); // 8 claims < 10
    const d = deps();
    const result = await scoreFaithfulnessSampled("S", md, CTX, d.deps, {
      rate: 0.25,
      minClaims: 10,
    });
    expect(d.judged.flat()).toHaveLength(8);
    expect(isPartialSample(result)).toBe(false);
    expect(summarizeFaithfulness(result)).not.toContain("SAMPLED");
  });

  it("scores a section too small to sample with the full check", async () => {
    const d = deps();
    const result = await scoreFaithfulnessSampled(
      "S",
      "One claim.\nClaim S0a holds.",
      CTX,
      d.deps,
      {
        rate: 0.25,
        minClaims: 10,
      },
    );
    expect(d.decomposed).toEqual(["One claim.\nClaim S0a holds."]);
    expect(result.sampled).toMatchObject({ passagesChecked: 1, passagesTotal: 1 });
    expect(isPartialSample(result)).toBe(false);
  });

  it("reports an unparseable sample decomposition as unverified, not as zero claims", async () => {
    const d = deps();
    d.deps.extractor.decompose.mockResolvedValueOnce({
      claims: [],
      unparseable: true,
      truncated: true,
    });
    const result = await scoreFaithfulnessSampled("S", section(40), CTX, d.deps, {
      rate: 0.25,
      minClaims: 10,
    });
    expect(result.verified).toBe(false);
    expect(result.unparseable).toBe("claims");
    expect(result.truncated).toBe(true);
    expect(d.judged).toEqual([]);
  });
});

describe("scoreUnderPolicy", () => {
  it("`on` decomposes the whole section and judges every claim", async () => {
    const d = deps();
    const md = section(40);
    const result = await scoreUnderPolicy(FULL_GROUNDING, "S", md, CTX, d.deps);
    expect(d.deps.extractor.decompose).toHaveBeenCalledTimes(1);
    expect(d.deps.extractor.decompose.mock.calls[0][0]).toBe(md);
    expect(d.judged[0]).toHaveLength(80);
    expect(result.sampled).toBeUndefined();
  });

  it("`sample` samples, with the per-call minimum it is given", async () => {
    const d = deps();
    const policy = { mode: "sample" as const, sampleRate: 0.05, minClaims: 10 };
    await scoreUnderPolicy(policy, "S", section(100), CTX, d.deps, 30);
    expect(d.judged.flat().length).toBeGreaterThanOrEqual(30);
    expect(d.judged.flat().length).toBeLessThan(200);
  });
});
