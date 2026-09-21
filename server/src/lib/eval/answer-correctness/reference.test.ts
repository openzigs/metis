/**
 * Epic #1316 / Issue #1319 — reference-answer schema, style rules and loader.
 *
 * The tests that matter here are not the shape checks. They are the ones that
 * prove the validator REFUSES input it must refuse: a model-shaped author, an
 * answer that points at a location instead of stating a fact, an answer longer
 * than the agreed style, and a snapshot mismatch. Each of those, if it slipped
 * through, would produce a healthy-looking number built on ground truth that is
 * not ground truth.
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import {
  countSentences,
  FLAG_PREFIX,
  isFlagged,
  LICENSE_PENDING,
  MAX_REFERENCE_SENTENCES,
  MODEL_AUTHOR_PATTERNS,
  ReferenceValidationError,
  REFERENCE_FILENAME,
  assertHumanAuthorship,
  flaggedFindings,
  loadReferenceSet,
  scorableAnswers,
  validateReferenceSet,
} from "./reference.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FORMAT_EXAMPLE = path.join(HERE, "__fixtures__", "reference.format-example.json");

const provenance = (over: Record<string, unknown> = {}) => ({
  author: "gh:some-person",
  date: "2026-08-27",
  ...over,
});

const answer = (over: Record<string, unknown> = {}) => ({
  queryId: "dq-ops-01",
  answer: "The metrics route returns 404 until METRICS_TOKEN is set, because it fails closed.",
  provenance: provenance(),
  ...over,
});

const set = (over: Record<string, unknown> = {}) => ({
  corpusId: "docretrieval-01-metis-docs",
  license: LICENSE_PENDING,
  snapshotCommit: "953bfe7034cd7a4f7e3c5ca82b03642a0cdebcf7",
  answers: [answer()],
  ...over,
});

const problemsOf = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    if (err instanceof ReferenceValidationError) return err.problems;
    throw err;
  }
  throw new Error("expected validateReferenceSet to throw");
};

describe("countSentences", () => {
  it("counts terminal punctuation, not periods", () => {
    expect(countSentences("One fact.")).toBe(1);
    expect(countSentences("One fact. Two facts.")).toBe(2);
    expect(countSentences("Is it? Yes! Certainly.")).toBe(3);
  });

  it("does not count a filename, a decimal or a common abbreviation as a boundary", () => {
    // Each of these would over-count under a naive split and reject a legal
    // one-sentence answer.
    expect(countSentences("The value lives in OPERATIONS.md and is a string.")).toBe(1);
    expect(countSentences("The default budget is 1.5 seconds.")).toBe(1);
    expect(countSentences("Retries stop after three attempts, e.g. on a 502.")).toBe(1);
    expect(countSentences("Both adapters (SQLite vs. Postgres) are supported.")).toBe(1);
  });

  it("counts a trailing sentence with no final punctuation", () => {
    expect(countSentences("A complete fact. A second one with no stop")).toBe(2);
  });

  it("is zero for empty or punctuation-only text", () => {
    expect(countSentences("   ")).toBe(0);
    expect(countSentences("...")).toBe(0);
  });
});

describe("assertHumanAuthorship", () => {
  it.each(MODEL_AUTHOR_PATTERNS)("rejects an author containing %s", (marker) => {
    expect(assertHumanAuthorship("author", `someone-${marker}-here`)).toContain(
      "looks like a model",
    );
  });

  it("is case insensitive", () => {
    expect(assertHumanAuthorship("author", "Claude Opus")).not.toBeNull();
    expect(assertHumanAuthorship("author", "GPT-5")).not.toBeNull();
  });

  it("accepts an ordinary person", () => {
    expect(assertHumanAuthorship("author", "gh:mcronin")).toBeNull();
    expect(assertHumanAuthorship("author", "someone@example.com")).toBeNull();
  });
});

describe("validateReferenceSet — structure and provenance", () => {
  it("accepts a minimal valid set", () => {
    const parsed = validateReferenceSet(set());
    expect(parsed.answers).toHaveLength(1);
    expect(parsed.answers[0]?.provenance.author).toBe("gh:some-person");
  });

  it("accepts an empty answers array — the not-yet-authored state is legitimate", () => {
    expect(validateReferenceSet(set({ answers: [] })).answers).toEqual([]);
  });

  it("requires author and date", () => {
    expect(
      problemsOf(() =>
        validateReferenceSet(set({ answers: [answer({ provenance: { date: "2026-08-27" } })] })),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("author")]));
    expect(
      problemsOf(() =>
        validateReferenceSet(set({ answers: [answer({ provenance: { author: "gh:x" } })] })),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("date")]));
  });

  it("rejects a non-ISO date", () => {
    expect(
      problemsOf(() =>
        validateReferenceSet(
          set({ answers: [answer({ provenance: provenance({ date: "27/08/2026" }) })] }),
        ),
      ),
    ).toEqual(expect.arrayContaining([expect.stringContaining("ISO date")]));
  });

  it("rejects a snapshotCommit that is not a git SHA", () => {
    expect(problemsOf(() => validateReferenceSet(set({ snapshotCommit: "HEAD" })))).toEqual(
      expect.arrayContaining([expect.stringContaining("git SHA")]),
    );
  });

  it("rejects a model-shaped author, naming the metric it would corrupt", () => {
    const problems = problemsOf(() =>
      validateReferenceSet(
        set({ answers: [answer({ provenance: provenance({ author: "claude-opus" }) })] }),
      ),
    );
    expect(problems.join("\n")).toContain("judge against itself");
  });

  it("rejects a model-shaped reviewer", () => {
    const problems = problemsOf(() =>
      validateReferenceSet(
        set({
          answers: [
            answer({
              provenance: provenance({ reviewedBy: "gpt-reviewer", reviewedAt: "2026-08-28" }),
            }),
          ],
        }),
      ),
    );
    expect(problems.join("\n")).toContain("looks like a model");
  });

  it("rejects a self-review — one person is one opinion, not two", () => {
    const problems = problemsOf(() =>
      validateReferenceSet(
        set({
          answers: [
            answer({
              provenance: provenance({ reviewedBy: "GH:Some-Person", reviewedAt: "2026-08-28" }),
            }),
          ],
        }),
      ),
    );
    expect(problems.join("\n")).toContain("same person as the author");
  });

  it("rejects a review recorded as happening before the answer was written", () => {
    const problems = problemsOf(() =>
      validateReferenceSet(
        set({
          answers: [
            answer({
              provenance: provenance({ reviewedBy: "gh:other", reviewedAt: "2026-08-26" }),
            }),
          ],
        }),
      ),
    );
    expect(problems.join("\n")).toContain("precedes");
  });

  it("rejects a half-recorded review in either direction", () => {
    expect(
      problemsOf(() =>
        validateReferenceSet(
          set({ answers: [answer({ provenance: provenance({ reviewedBy: "gh:other" }) })] }),
        ),
      ).join("\n"),
    ).toContain("reviewedAt");
    expect(
      problemsOf(() =>
        validateReferenceSet(
          set({ answers: [answer({ provenance: provenance({ reviewedAt: "2026-08-28" }) })] }),
        ),
      ).join("\n"),
    ).toContain("reviewedBy");
  });

  it("reports EVERY problem at once, so one pass fixes the file", () => {
    const problems = problemsOf(() =>
      validateReferenceSet(
        set({
          corpusId: "wrong-corpus",
          answers: [
            answer({ provenance: provenance({ author: "claude" }) }),
            answer({ queryId: "dq-ops-01" }),
          ],
        }),
        { expectedCorpusId: "docretrieval-01-metis-docs" },
      ),
    );
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join("\n")).toContain("wrong-corpus");
    expect(problems.join("\n")).toContain("duplicate");
  });

  it("checks referential integrity against the corpus's query ids", () => {
    expect(
      problemsOf(() =>
        validateReferenceSet(set({ answers: [answer({ queryId: "dq-nope-99" })] }), {
          knownQueryIds: ["dq-ops-01", "dq-ops-02"],
        }),
      ).join("\n"),
    ).toContain("unknown query id");
  });

  it("rejects a snapshot mismatch rather than warning — the text may no longer exist", () => {
    expect(
      problemsOf(() =>
        validateReferenceSet(set(), {
          expectedSnapshotCommit: "0123456789abcdef0123456789abcdef01234567",
        }),
      ).join("\n"),
    ).toContain("does not match the corpus snapshot");
  });
});

describe("validateReferenceSet — answer style (decision 4)", () => {
  it("accepts one to three sentences of plain prose", () => {
    for (const text of [
      "Up to five minutes of data may be lost.",
      "Up to five minutes of data may be lost. The backup runs hourly.",
      "One. Two. Three.",
    ]) {
      expect(
        validateReferenceSet(set({ answers: [answer({ answer: text })] })).answers,
      ).toHaveLength(1);
    }
  });

  it(`rejects more than ${MAX_REFERENCE_SENTENCES} sentences`, () => {
    expect(
      problemsOf(() =>
        validateReferenceSet(set({ answers: [answer({ answer: "One. Two. Three. Four." })] })),
      ).join("\n"),
    ).toContain("sentence");
  });

  it("rejects a bullet list", () => {
    expect(
      problemsOf(() =>
        validateReferenceSet(
          set({ answers: [answer({ answer: "The steps are:\n- one\n- two" })] }),
        ),
      ).join("\n"),
    ).toContain("prose");
  });

  it("rejects a markdown table", () => {
    expect(
      problemsOf(() =>
        validateReferenceSet(
          set({
            answers: [answer({ answer: "The limits are shown here.\n| a | b |\n| - | - |" })],
          }),
        ),
      ).join("\n"),
    ).toContain("prose");
  });

  it("rejects a heading and a code fence", () => {
    expect(
      problemsOf(() =>
        validateReferenceSet(set({ answers: [answer({ answer: "## RPO\nFive minutes." })] })),
      ).join("\n"),
    ).toContain("prose");
    expect(
      problemsOf(() =>
        validateReferenceSet(set({ answers: [answer({ answer: "Run it.\n```\npnpm x\n```" })] })),
      ).join("\n"),
    ).toContain("prose");
  });

  it.each([
    ["a footnote marker", "The RPO is five minutes.[^1]"],
    ["a bracketed citation", "The RPO is five minutes [1]."],
    ["a markdown link", "The RPO is [five minutes](docs/OPERATIONS.md)."],
    ["a superscript", "The RPO is five minutes.<sup>2</sup>"],
  ])("rejects citation markup — %s", (_label, text) => {
    expect(
      problemsOf(() => validateReferenceSet(set({ answers: [answer({ answer: text })] }))).join(
        "\n",
      ),
    ).toContain("citation markup");
  });

  it("rejects an answer that points at a location instead of stating the fact", () => {
    for (const text of [
      "See OPERATIONS.md for the RPO.",
      "Refer to the RPO row in the operations runbook.",
      "As described in SECURITY.md, the token is required.",
      "According to data-model.md the column is nullable.",
      "Documented in OPERATIONS.md under Backups.",
    ]) {
      expect(
        problemsOf(() => validateReferenceSet(set({ answers: [answer({ answer: text })] }))).join(
          "\n",
        ),
      ).toContain("states the fact");
    }
  });

  it("does not reject a fact that merely happens to name a document", () => {
    const text =
      "The runbook OPERATIONS.md is the deploy source of truth and is reviewed quarterly.";
    expect(validateReferenceSet(set({ answers: [answer({ answer: text })] })).answers).toHaveLength(
      1,
    );
  });
});

describe("FLAG items", () => {
  const flagged = answer({
    queryId: "dq-sec-04",
    answer: `${FLAG_PREFIX} the anchored quote describes the login route, but the question asks about token rotation, so this query has no answer in the snapshot.`,
  });

  it("recognises the marker", () => {
    expect(isFlagged(flagged.answer)).toBe(true);
    expect(isFlagged("A normal answer.")).toBe(false);
    expect(isFlagged("  flag: lowercase and indented is still a flag")).toBe(true);
  });

  it("exempts a flag from the prose style rules — it is a note, not a gold answer", () => {
    const parsed = validateReferenceSet(
      set({
        answers: [
          answer({
            queryId: "dq-sec-04",
            answer: `${FLAG_PREFIX} the quote does not answer this. See queries.json. One. Two. Three. Four.`,
          }),
        ],
      }),
    );
    expect(parsed.answers).toHaveLength(1);
  });

  it("still requires provenance on a flag", () => {
    expect(
      problemsOf(() =>
        validateReferenceSet(
          set({ answers: [{ queryId: "dq-sec-04", answer: `${FLAG_PREFIX} broken` }] }),
        ),
      ).join("\n"),
    ).toContain("provenance");
  });

  it("rejects a flag with no explanation after the marker", () => {
    expect(
      problemsOf(() =>
        validateReferenceSet(set({ answers: [answer({ answer: `${FLAG_PREFIX}   ` })] })),
      ).join("\n"),
    ).toContain("explain");
  });

  it("splits scorable answers from findings", () => {
    const parsed = validateReferenceSet(set({ answers: [answer(), flagged] }));
    expect(scorableAnswers(parsed).map((a) => a.queryId)).toEqual(["dq-ops-01"]);
    const findings = flaggedFindings(parsed);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.queryId).toBe("dq-sec-04");
    // The marker is stripped: the finding is the author's explanation.
    expect(findings[0]?.finding.startsWith("FLAG")).toBe(false);
    expect(findings[0]?.finding).toContain("token rotation");
  });
});

describe("licence", () => {
  it("treats the PENDING sentinel as an undecided licence, not a licence", () => {
    expect(validateReferenceSet(set()).license).toBe(LICENSE_PENDING);
    expect(validateReferenceSet(set()).licensePending).toBe(true);
  });

  it("reports a real licence as decided", () => {
    expect(validateReferenceSet(set({ license: "CC0-1.0" })).licensePending).toBe(false);
  });

  it("requires a licence field to be present at all", () => {
    const bare = set();
    delete (bare as Record<string, unknown>).license;
    expect(problemsOf(() => validateReferenceSet(bare)).join("\n")).toContain("license");
  });
});

describe("loadReferenceSet", () => {
  const withDir = async (fn: (dir: string) => Promise<void>) => {
    const dir = await mkdtemp(path.join(tmpdir(), "ref-"));
    try {
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };

  it("reports an absent file as absent, not as an error", async () => {
    await withDir(async (dir) => {
      const lookup = await loadReferenceSet(dir);
      expect(lookup.status).toBe("absent");
    });
  });

  it("distinguishes empty from present", async () => {
    await withDir(async (dir) => {
      await writeFile(path.join(dir, REFERENCE_FILENAME), JSON.stringify(set({ answers: [] })));
      expect((await loadReferenceSet(dir)).status).toBe("empty");
      await writeFile(path.join(dir, REFERENCE_FILENAME), JSON.stringify(set()));
      expect((await loadReferenceSet(dir)).status).toBe("present");
    });
  });

  it("treats a file of only FLAG items as empty — nothing scorable", async () => {
    await withDir(async (dir) => {
      await writeFile(
        path.join(dir, REFERENCE_FILENAME),
        JSON.stringify(
          set({ answers: [answer({ answer: `${FLAG_PREFIX} the quote does not answer this` })] }),
        ),
      );
      const lookup = await loadReferenceSet(dir);
      expect(lookup.status).toBe("empty");
    });
  });

  it("surfaces malformed JSON as a validation error naming the file", async () => {
    await withDir(async (dir) => {
      await writeFile(path.join(dir, REFERENCE_FILENAME), "{ not json");
      await expect(loadReferenceSet(dir)).rejects.toThrow(ReferenceValidationError);
    });
  });
});

describe("the committed format example", () => {
  it("is unmistakably labelled as not being ground truth", () => {
    const raw = JSON.parse(readFileSync(FORMAT_EXAMPLE, "utf8")) as Record<string, unknown>;
    expect(String(raw.__FORMAT_EXAMPLE__)).toContain("NOT GROUND TRUTH");
    expect(raw.corpusId).not.toBe("docretrieval-01-metis-docs");
  });

  it("validates against the schema it documents", () => {
    const raw = JSON.parse(readFileSync(FORMAT_EXAMPLE, "utf8"));
    const parsed = validateReferenceSet(raw);
    expect(scorableAnswers(parsed).length).toBeGreaterThan(0);
    expect(flaggedFindings(parsed).length).toBeGreaterThan(0);
  });
});
