/**
 * Epic #1316 / Issue #1319 — the answer-correctness run, end to end over a real
 * corpus directory on disk.
 *
 * The committed corpus is exercised directly (not a copy) because the property
 * that matters most about it is that it ships with NO fabricated gold answers,
 * and a test against a copy would not notice if that changed.
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaimVerdict } from "../../docs-gen/grounding/faithfulness-judge.js";
import { runAnswerCorrectness, scoreReferenceSet } from "./runner.js";
import { offlineJudgeDeps } from "./judge-deps.js";
import type { ScoreAnswerCorrectnessDeps } from "./metric.js";
import {
  assertHumanAuthorship,
  FLAG_PREFIX,
  LICENSE_PENDING,
  REFERENCE_FILENAME,
  validateReferenceSet,
} from "./reference.js";
import { defaultResultsDir, loadAllRuns } from "../domain/results-store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..", "..", "..");
const CORPUS_ID = "docretrieval-01-metis-docs";
const CORPUS_DIR = path.join(REPO_ROOT, "eval-data", "corpus", CORPUS_ID);

const deps: ScoreAnswerCorrectnessDeps = {
  extractor: {
    decompose: async (text: string) => ({
      claims: text
        .split(/(?<=[.!?])\s+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((claim) => ({ claim, sourceIds: [] })),
    }),
  },
  judge: {
    judge: async (claims: string[]): Promise<ClaimVerdict[]> =>
      claims.map((claim) => ({ claim, supported: true, sourceIds: [] })),
  },
};

const provenance = { author: "gh:some-person", date: "2026-08-27" };

const withCorpus = async (answers: unknown[], fn: (dir: string) => Promise<void>) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ac-corpus-"));
  try {
    await writeFile(
      path.join(dir, REFERENCE_FILENAME),
      JSON.stringify({
        corpusId: CORPUS_ID,
        license: LICENSE_PENDING,
        snapshotCommit: "953bfe7034cd7a4f7e3c5ca82b03642a0cdebcf7",
        answers,
      }),
    );
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

describe("runAnswerCorrectness — the not-yet-authored states", () => {
  it("reports NOT REPORTED for a corpus with no reference.json", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ac-empty-"));
    try {
      const env = await runAnswerCorrectness({
        corpusId: CORPUS_ID,
        corpusDir: dir,
        generated: [],
        deps,
      });
      expect(env.reported).toBe(false);
      expect(env.reasonCode).toBe("no-reference-file");
      expect(env.reason).toContain(`${CORPUS_ID}/${REFERENCE_FILENAME}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("never leaks an absolute filesystem path into the committed envelope", async () => {
    // The envelope is committed to eval-results/. On a developer's box an
    // absolute path embeds a home directory and a username; on CI it embeds the
    // runner's workspace layout.
    const dir = await mkdtemp(path.join(tmpdir(), "ac-path-"));
    try {
      const env = await runAnswerCorrectness({
        corpusId: CORPUS_ID,
        corpusDir: dir,
        generated: [],
        deps,
      });
      const serialised = JSON.stringify(env);
      expect(serialised).not.toContain(dir);
      expect(serialised).not.toContain(tmpdir());
      expect(serialised).not.toMatch(/(?:^|")\/(?:Users|home|tmp|var)\//);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports NOT REPORTED — not a mean of 0 — for an empty answers array", async () => {
    await withCorpus([], async (dir) => {
      const env = await runAnswerCorrectness({
        corpusId: CORPUS_ID,
        corpusDir: dir,
        generated: [{ queryId: "dq-ops-01", answer: "anything" }],
        deps,
      });
      expect(env.reported).toBe(false);
      expect(env.reasonCode).toBe("no-gold-answers");
      expect(env.aggregate).toBeUndefined();
      expect(env.reason).toContain("judge against itself");
    });
  });

  it("carries the pending-licence flag even when no score is reported", async () => {
    await withCorpus([], async (dir) => {
      const env = await runAnswerCorrectness({
        corpusId: CORPUS_ID,
        corpusDir: dir,
        generated: [],
        deps,
      });
      expect(env.licensePending).toBe(true);
    });
  });
});

describe("runAnswerCorrectness — FLAG items", () => {
  const flag = {
    queryId: "dq-sec-01",
    answer: `${FLAG_PREFIX} the anchored quote covers session cookies, not token rotation`,
    provenance,
  };
  const gold = {
    queryId: "dq-ops-01",
    answer: "The metrics route returns 404 until METRICS_TOKEN is set.",
    provenance,
  };

  it("excludes a flagged query from the metric and reports it as a corpus finding", async () => {
    await withCorpus([gold, flag], async (dir) => {
      const env = await runAnswerCorrectness({
        corpusId: CORPUS_ID,
        corpusDir: dir,
        generated: [
          {
            queryId: "dq-ops-01",
            answer: "The metrics route returns 404 until METRICS_TOKEN is set.",
          },
          { queryId: "dq-sec-01", answer: "Tokens rotate every 30 days." },
        ],
        deps,
      });
      expect(env.reported).toBe(true);
      expect(env.referenceCount).toBe(1);
      expect(env.perQuery?.map((q) => q.queryId)).toEqual(["dq-ops-01"]);
      expect(env.corpusFindings?.map((f) => f.queryId)).toEqual(["dq-sec-01"]);
      expect(env.corpusFindings?.[0]?.finding).toContain("session cookies");
    });
  });

  it("reports findings even when EVERY item is flagged and nothing is scorable", async () => {
    await withCorpus([flag], async (dir) => {
      const env = await runAnswerCorrectness({
        corpusId: CORPUS_ID,
        corpusDir: dir,
        generated: [{ queryId: "dq-sec-01", answer: "Tokens rotate every 30 days." }],
        deps,
      });
      expect(env.reported).toBe(false);
      expect(env.reason).toContain("FLAG");
      expect(env.corpusFindings).toHaveLength(1);
    });
  });
});

describe("scoreReferenceSet", () => {
  const set = (answers: unknown[]) =>
    validateReferenceSet({
      corpusId: CORPUS_ID,
      license: LICENSE_PENDING,
      snapshotCommit: "953bfe70",
      answers,
    });

  it("records a query the system never answered as unverifiable, not as 0", async () => {
    const results = await scoreReferenceSet(
      set([{ queryId: "dq-ops-01", answer: "The RPO is five minutes.", provenance }]),
      [],
      deps,
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.f1).toBeNull();
    expect(results[0]?.unverifiableReason).toBe("no-claims");
  });

  it("scores only the queries that have gold, ignoring extra generated answers", async () => {
    const results = await scoreReferenceSet(
      set([{ queryId: "dq-ops-01", answer: "The RPO is five minutes.", provenance }]),
      [
        { queryId: "dq-ops-01", answer: "Five minutes of data may be lost." },
        { queryId: "dq-ops-02", answer: "irrelevant" },
      ],
      deps,
    );
    expect(results.map((r) => r.queryId)).toEqual(["dq-ops-01"]);
    expect(results[0]?.f1).toBe(1);
  });
});

describe("the committed docretrieval-01-metis-docs corpus", () => {
  const raw = JSON.parse(readFileSync(path.join(CORPUS_DIR, REFERENCE_FILENAME), "utf8")) as Record<
    string,
    unknown
  >;

  it("ships only HUMAN-authored gold answers — never model-generated", () => {
    // Until 2026-08-30 this asserted `answers` was EMPTY, because none had been
    // written yet and the risk was a model filling it. The first four were then
    // authored by a person (#1319), so the guard now checks the property that
    // actually matters rather than the count that used to imply it: every entry
    // names a human author, and no author matches a model. Asserting emptiness
    // again would make the corpus uncommittable the moment it does its job.
    const answers = raw.answers as Array<{ provenance?: { author?: string } }>;
    expect(Array.isArray(answers)).toBe(true);
    for (const a of answers) {
      const author = a.provenance?.author ?? "";
      expect(author.length).toBeGreaterThan(0);
      // Same blocklist the loader enforces — a model-authored reference makes
      // the whole metric a measurement of the judge against itself.
      expect(assertHumanAuthorship("author", author)).toBeNull();
    }
  });

  it("declares a REAL licence, not the undecided sentinel", () => {
    // Until #1382 this asserted the opposite: `license` had to be LICENSE_PENDING,
    // because picking one silently would have been the failure mode while the
    // question was genuinely open (#1322 E4, #1300). #1382 answered it — the
    // corpus is the repository owner's own documentation, so the licence was
    // theirs to set, and the file now ships in the published tree where an
    // unlicensed file cannot go. What must not regress is the sentinel creeping
    // back in as a way to defer the decision again.
    expect(raw.license).toBe("CC0-1.0");
    expect(raw.license).not.toBe(LICENSE_PENDING);
    expect(String(raw.licenseNote)).toMatch(/#1382/);
  });

  it("validates against the corpus's own query ids and snapshot commit", async () => {
    const queries = JSON.parse(readFileSync(path.join(CORPUS_DIR, "queries.json"), "utf8")) as {
      snapshotCommit: string;
      queries: { id: string }[];
    };
    const env = await runAnswerCorrectness({
      corpusId: CORPUS_ID,
      corpusDir: CORPUS_DIR,
      generated: [],
      deps,
      validate: {
        expectedCorpusId: CORPUS_ID,
        expectedSnapshotCommit: queries.snapshotCommit,
        knownQueryIds: queries.queries.map((q) => q.id),
      },
    });
    expect(env.reported).toBe(false);
    // Settled by #1382 — see the licence test above. `licensePending` is still a
    // real state the loader can report; no committed corpus is in it.
    expect(env.licensePending).toBe(false);
    // Scope decision 2: all questions of this corpus, not the wide corpus — 43 since five
    // were removed with their document before publication (48 before).
    expect(queries.queries).toHaveLength(43);
  });
});

describe("the domain results store does not mistake this envelope for a domain run", () => {
  // The one defect this wiring could plausibly ship: writing a fragment into
  // eval-results/ that `loadAllRuns` either mis-parses or silently drops, so the
  // write succeeds and no reader ever sees it. The answer-correctness envelope
  // therefore lives in its own SUBDIRECTORY, which `listRunIds` cannot pick up
  // because it filters on a `.json` suffix.
  it("ignores a subdirectory beside the domain run envelopes", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "ac-results-"));
    try {
      const { mkdir } = await import("node:fs/promises");
      await mkdir(path.join(dir, "answer-correctness"), { recursive: true });
      await writeFile(
        path.join(dir, "answer-correctness", "2026-08-28.json"),
        JSON.stringify({ metric: "answer_correctness", corpusId: CORPUS_ID, reported: false }),
      );
      expect(await loadAllRuns(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resolves the repository's real eval-results directory", () => {
    // Guards the path arithmetic the script depends on.
    expect(defaultResultsDir(REPO_ROOT)).toBe(path.join(REPO_ROOT, "eval-results"));
  });
});

describe("runAnswerCorrectness — the three NOT REPORTED reasons are distinguishable (#1338)", () => {
  const gold = {
    queryId: "dq-ops-01",
    answer: "The metrics route returns 404 until METRICS_TOKEN is set.",
    provenance,
  };
  const answered = [
    { queryId: "dq-ops-01", answer: "Until METRICS_TOKEN is set, /metrics answers 404." },
  ];

  it("distinguishes no-reference-file from no-gold-answers from no-generated-answers", async () => {
    // The whole point of #1338's fourth criterion: an author who fills
    // reference.json and re-runs must be told WHICH wall they hit next.
    const codes: (string | undefined)[] = [];

    const bare = await mkdtemp(path.join(tmpdir(), "ac-codes-"));
    try {
      codes.push(
        (await runAnswerCorrectness({ corpusId: CORPUS_ID, corpusDir: bare, deps })).reasonCode,
      );
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
    await withCorpus([], async (dir) => {
      codes.push(
        (await runAnswerCorrectness({ corpusId: CORPUS_ID, corpusDir: dir, deps })).reasonCode,
      );
    });
    await withCorpus([gold], async (dir) => {
      codes.push(
        (await runAnswerCorrectness({ corpusId: CORPUS_ID, corpusDir: dir, deps })).reasonCode,
      );
    });

    expect(codes).toEqual(["no-reference-file", "no-gold-answers", "no-generated-answers"]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("says the generated side did not run — and scores nothing as 0", async () => {
    await withCorpus([gold], async (dir) => {
      const env = await runAnswerCorrectness({ corpusId: CORPUS_ID, corpusDir: dir, deps });
      expect(env.reported).toBe(false);
      expect(env.reasonCode).toBe("no-generated-answers");
      expect(env.reason).toContain("METIS produced no answer");
      expect(env.perQuery?.map((q) => q.f1)).toEqual([null]);
      expect(env.aggregate?.meanF1).toBeNull();
      expect(env.aggregate?.scored).toBe(0);
    });
  });

  it("reports no-judge with NO generated answers either — the real no-provider shape", async () => {
    // The case the CLI actually produces: with no provider it does not generate
    // either, so BOTH causes are live at once and only one can be named. Naming
    // the generated side would send an author to fix generation and hit the
    // same wall. (The variant below, with answers present, cannot distinguish
    // the two orderings on its own.)
    await withCorpus([gold], async (dir) => {
      const offline = offlineJudgeDeps("no AI provider is configured for this test.");
      const env = await runAnswerCorrectness({
        corpusId: CORPUS_ID,
        corpusDir: dir,
        generated: [],
        deps: offline.deps,
        judgeUnavailable: offline.unavailableReason ?? undefined,
      });
      expect(env.reasonCode).toBe("no-judge");
      expect(env.reason).toContain("no AI provider is configured");
      expect(env.perQuery?.map((q) => q.f1)).toEqual([null]);
    });
  });

  it("reports no-judge — NOT no-generated-answers — when there is no provider", async () => {
    // Precedence. Without a judge nothing is scorable however many answers were
    // generated; naming the downstream cause would send an author to fix
    // generation and hit the same wall.
    await withCorpus([gold], async (dir) => {
      const offline = offlineJudgeDeps("no AI provider is configured for this test.");
      const env = await runAnswerCorrectness({
        corpusId: CORPUS_ID,
        corpusDir: dir,
        generated: answered,
        deps: offline.deps,
        judgeUnavailable: offline.unavailableReason ?? undefined,
      });
      expect(env.reported).toBe(false);
      expect(env.reasonCode).toBe("no-judge");
      expect(env.reason).toContain("no AI provider is configured");
      // AC: every score UNVERIFIABLE with a reason, asserted — never 0.
      expect(env.perQuery).toHaveLength(1);
      for (const q of env.perQuery ?? []) {
        expect(q.f1).toBeNull();
        expect(q.f1).not.toBe(0);
        expect(q.precision).toBeNull();
        expect(q.recall).toBeNull();
        expect(q.unverifiableReason).toBe("judge-unavailable");
      }
      expect(env.aggregate?.unverifiable).toBe(1);
    });
  });

  it("reports a real mean, a scored count and an unverifiable count once both sides are live", async () => {
    await withCorpus(
      [gold, { queryId: "dq-ops-02", answer: "Metrics live under eval-results.", provenance }],
      async (dir) => {
        const env = await runAnswerCorrectness({
          corpusId: CORPUS_ID,
          corpusDir: dir,
          // Only one of the two gold queries gets an answer, so the run carries
          // a scored count AND an unverifiable count at once.
          generated: answered,
          deps,
        });
        expect(env.reported).toBe(true);
        expect(env.reasonCode).toBeUndefined();
        expect(env.aggregate?.meanF1).toBe(1);
        expect(env.aggregate?.scored).toBe(1);
        expect(env.aggregate?.unverifiable).toBe(1);
        expect(env.referenceCount).toBe(2);
      },
    );
  });
});

describe("runAnswerCorrectness — generation is LAZY (#1338)", () => {
  const gold = { queryId: "dq-ops-01", answer: "The RPO is five minutes.", provenance };

  it("never asks METIS anything when there is no gold to compare against", async () => {
    // Generation ingests a corpus and makes one model call per query. Doing that
    // for a reference set nothing can be scored against is the hour #1338 exists
    // to stop wasting.
    const generate = vi.fn(async () => []);
    await withCorpus([], async (dir) => {
      await runAnswerCorrectness({ corpusId: CORPUS_ID, corpusDir: dir, generate, deps });
    });
    const bare = await mkdtemp(path.join(tmpdir(), "ac-lazy-"));
    try {
      await runAnswerCorrectness({ corpusId: CORPUS_ID, corpusDir: bare, generate, deps });
    } finally {
      await rm(bare, { recursive: true, force: true });
    }
    expect(generate).not.toHaveBeenCalled();
  });

  it("asks for exactly the SCORABLE gold ids — flagged items are not questions to answer", async () => {
    const generate = vi.fn(async () => [{ queryId: "dq-ops-01", answer: "Five minutes." }]);
    await withCorpus(
      [
        gold,
        {
          queryId: "dq-sec-01",
          answer: `${FLAG_PREFIX} the anchored quote is about cookies`,
          provenance,
        },
      ],
      async (dir) => {
        const env = await runAnswerCorrectness({
          corpusId: CORPUS_ID,
          corpusDir: dir,
          generate,
          deps,
        });
        expect(generate).toHaveBeenCalledWith(["dq-ops-01"]);
        expect(env.reported).toBe(true);
        expect(env.aggregate?.scored).toBe(1);
      },
    );
  });

  it("prefers the generator over an eagerly-supplied generated list", async () => {
    await withCorpus([gold], async (dir) => {
      const env = await runAnswerCorrectness({
        corpusId: CORPUS_ID,
        corpusDir: dir,
        generated: [{ queryId: "dq-ops-01", answer: "stale" }],
        generate: async () => [{ queryId: "dq-ops-01", answer: "The RPO is five minutes." }],
        deps,
      });
      expect(env.aggregate?.scored).toBe(1);
    });
  });
});
