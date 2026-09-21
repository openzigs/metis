/**
 * Corpus tests — these run in CI and guard the committed ground truth. They need
 * no weights and no network: the snapshot is parsed with METIS's own parser.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs, symlinkSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { EvalCodeSymbol } from "../codegraph/fixture.js";
import {
  buildDocText,
  buildSchemaSymbolsFromOrm,
  corpusDir,
  DEFAULT_CORPUS_ID,
  deriveStrata,
  generousTokens,
  LEGACY_CORPUS_ID,
  loadEmbedRetrievalCorpus,
  loadSnapshotManifest,
  REDACTED_SNAPSHOT_FILES,
  resolveQuery,
  snapshotSourceFor,
  SNAPSHOT_SOURCE_ROOTS,
  EMBED_RETRIEVAL_PROJECT_ID,
} from "./corpus.js";

/** Corpus directory, as a function so the constant below stays lazily resolved. */
const dirFor = (id: string): string => corpusDir(id);

const symbol = (over: Partial<EvalCodeSymbol> = {}): EvalCodeSymbol => ({
  id: "a.ts::alpha",
  projectId: EMBED_RETRIEVAL_PROJECT_ID,
  kind: "function",
  name: "alpha",
  qualifiedName: "alpha",
  filePath: "a.ts",
  startLine: 1,
  endLine: 2,
  language: "typescript",
  ...over,
});

describe("buildDocText", () => {
  it("uses the PRODUCTION formatter and slices the symbol's body out of the file", () => {
    const text = buildDocText(
      symbol({ startLine: 2, endLine: 3 }),
      "// header\nfunction alpha() {\n  return 1;\n}\n",
    );
    expect(text).toBe("function alpha in a.ts\nfunction alpha() {\n  return 1;");
  });

  it("survives a symbol whose file content is missing (no body lines)", () => {
    expect(buildDocText(symbol(), "")).toBe("function alpha in a.ts\n");
  });
});

describe("resolveQuery", () => {
  const symbols = [symbol(), symbol({ id: "b.ts::beta", name: "beta", filePath: "b.ts" })];

  it("resolves ground-truth targets to parsed symbol ids", () => {
    const q = resolveQuery(
      { id: "Q1", requirement: "req", relevant: [{ name: "beta", filePath: "b.ts" }] },
      symbols,
    );
    expect(q.relevant).toEqual(["b.ts::beta"]);
  });

  it("fails LOUDLY on a stale label rather than silently scoring an unreachable miss", () => {
    expect(() =>
      resolveQuery(
        { id: "Q1", requirement: "req", relevant: [{ name: "gone", filePath: "b.ts" }] },
        symbols,
      ),
    ).toThrow(/not in the snapshot/);
  });

  it("rejects a query with no relevant symbols", () => {
    expect(() => resolveQuery({ id: "Q1", requirement: "req", relevant: [] }, symbols)).toThrow(
      /no relevant symbols/,
    );
  });
});

describe("corpusDir", () => {
  it("resolves a corpus id under eval-data/corpus", () => {
    expect(corpusDir("embedretrieval-01-nl-to-code")).toMatch(
      /eval-data[/\\]corpus[/\\]embedretrieval-01-nl-to-code$/,
    );
  });

  it("defaults to the #1157 corpus", () => {
    expect(corpusDir()).toBe(corpusDir(DEFAULT_CORPUS_ID));
  });

  // The id reaches this from `--corpus` on the CLI. Containment is cheaper than
  // reasoning about who can pass the flag.
  it.each([
    ["../../etc", "parent traversal"],
    ["../codegraph-01-citation", "a sibling corpus by traversal"],
    ["/etc/passwd", "an absolute path"],
  ])("rejects %s (%s)", (id) => {
    expect(() => corpusDir(id)).toThrow(/outside eval-data\/corpus/);
  });

  it("allows a nested id that stays inside the root", () => {
    expect(() => corpusDir("embedretrieval-02-nl-to-code")).not.toThrow();
  });

  // `eval-data/corpus/` is the directory OF corpora, not a corpus. Returning it
  // turned `--corpus ""` into an ENOENT on `<root>/queries.json` several frames
  // later, which names the wrong thing (PR #1174 review).
  it.each([
    ["", "an empty id"],
    [".", "the current directory"],
    ["embedretrieval-01-nl-to-code/..", "a traversal that lands back on the root"],
  ])("rejects %o (%s) rather than returning the corpus root", (id) => {
    expect(() => corpusDir(id)).toThrow(/directory of corpora rather than a corpus/);
  });

  it("names the offending id in the root-resolving error", () => {
    expect(() => corpusDir(".")).toThrow(/Corpus id "\."/);
  });

  /**
   * The lexical `path.resolve` check is blind to symlinks: a link committed inside
   * `eval-data/corpus/` passes the prefix test while reading from anywhere on disk.
   * Nothing there is a symlink today, so this builds one, asserts it is refused, and
   * removes it in `finally` — the assertion runs on a real link rather than a mock.
   */
  it("rejects a symlink inside the corpus root that points outside it", () => {
    const root = path.dirname(corpusDir(DEFAULT_CORPUS_ID));
    const linkName = `.tmp-escape-${process.pid}`;
    const linkPath = path.join(root, linkName);
    symlinkSync(os.tmpdir(), linkPath);
    try {
      expect(() => corpusDir(linkName)).toThrow(/outside eval-data\/corpus\/ through a symlink/);
    } finally {
      unlinkSync(linkPath);
    }
  });

  it("returns an id that does not exist yet, leaving it to the lexical check", () => {
    // `realpathSync` throws ENOENT here; there is no link to follow, so the
    // lexical containment already decided it.
    expect(corpusDir("not-created-yet")).toMatch(/eval-data[/\\]corpus[/\\]not-created-yet$/);
  });
});

describe("generousTokens", () => {
  // The whole point: it splits underscores, which the PRODUCTION tokenizer does
  // not. If this ever stops being true the keywordFree stratum silently
  // re-partitions itself the moment #1159 lands.
  it("splits snake_case as well as camelCase", () => {
    expect(generousTokens("workspace_members")).toEqual(["workspace", "members"]);
    expect(generousTokens("getUserEmail")).toEqual(["get", "user", "email"]);
  });
});

describe("deriveStrata", () => {
  const target = (
    name: string,
    qualifiedName = name,
  ): Pick<EvalCodeSymbol, "name" | "qualifiedName"> => ({
    name,
    qualifiedName,
  });

  it("marks a target carrying an underscore as snake", () => {
    expect(deriveStrata("anything at all", [target("workspace_members")]).naming).toBe("snake");
  });

  it("marks a camelCase-only target set as camel", () => {
    expect(deriveStrata("anything at all", [target("issueTokens")]).naming).toBe("camel");
  });

  it("marks one snake target among camel ones as snake", () => {
    expect(deriveStrata("x", [target("issueTokens"), target("workspace_members")]).naming).toBe(
      "snake",
    );
  });

  it("is keywordFree when the requirement shares no word with the target", () => {
    expect(
      deriveStrata("Nobody may learn that a project exists", [target("assertAccessibleOrNotFound")])
        .keywordFree,
    ).toBe(true);
  });

  it("is NOT keywordFree when a word is shared through the qualifiedName alone", () => {
    expect(
      deriveStrata("the ranking must merge two lists", [target("fuse", "Ranking.fuse")])
        .keywordFree,
    ).toBe(false);
  });

  // The `every` vs `some` choice is the difference between "unreachable" and
  // "partly reachable": one matchable target is enough for BM25 to score it.
  it("is NOT keywordFree when only ONE of several targets is lexically reachable", () => {
    expect(
      deriveStrata("the ranking must merge two lists", [
        target("assertAccessibleOrNotFound"),
        target("ranking"),
      ]).keywordFree,
    ).toBe(false);
  });

  it("does not treat an underscore-joined name as keyword-free (the #1159 trap)", () => {
    // Production `tokenizeCode` emits `workspace_members` as ONE term, so it
    // would call this keyword-free. The generous tokenizer must not.
    expect(
      deriveStrata("the workspace members of an organisation", [target("workspace_members")])
        .keywordFree,
    ).toBe(false);
  });
});

describe("buildSchemaSymbolsFromOrm", () => {
  const prisma = `model AlertRule {
  id           String @id
  thresholdPct Float
  @@map("alert_rules")
}`;

  it("materialises table + column symbols through the production extractor", () => {
    const symbols = buildSchemaSymbolsFromOrm(
      [{ relPath: "schema.prisma", content: prisma }],
      EMBED_RETRIEVAL_PROJECT_ID,
    );
    expect(symbols.map((s) => [s.kind, s.qualifiedName])).toEqual([
      ["table", "alert_rules"],
      ["column", "alert_rules.id"],
      ["column", "alert_rules.thresholdpct"],
    ]);
    expect(symbols.every((s) => s.language === "sql")).toBe(true);
  });

  it("dedupes by qualifiedName, mirroring the writer's ensureTable cache", () => {
    const symbols = buildSchemaSymbolsFromOrm(
      [
        { relPath: "a.prisma", content: prisma },
        { relPath: "b.prisma", content: prisma },
      ],
      EMBED_RETRIEVAL_PROJECT_ID,
    );
    expect(symbols.filter((s) => s.kind === "table")).toHaveLength(1);
  });

  it("yields nothing for a file the ORM extractor does not handle", () => {
    expect(
      buildSchemaSymbolsFromOrm(
        [{ relPath: "notes.txt", content: prisma }],
        EMBED_RETRIEVAL_PROJECT_ID,
      ),
    ).toEqual([]);
  });
});

describe("the legacy corpus (embedretrieval-01) is unchanged by #1157", () => {
  // Committed eval-results/*.md cite this corpus by name and snapshotCommit. If
  // #1157 moved its numbers those files would silently become lies.
  it("still loads 30 queries with searchable === docs (no schema dir)", async () => {
    const corpus = await loadEmbedRetrievalCorpus(corpusDir(LEGACY_CORPUS_ID));
    expect(corpus.spec.id).toBe(LEGACY_CORPUS_ID);
    expect(corpus.queries).toHaveLength(30);
    expect(corpus.docs.length).toBeGreaterThanOrEqual(100);
    expect(corpus.searchable).toHaveLength(corpus.docs.length);
    expect(corpus.symbols).toHaveLength(corpus.docs.length);
    expect(corpus.queries.every((q) => q.strata === null)).toBe(true);
  });
});

describe("the committed corpus", () => {
  it("loads, parses real METIS symbols, and every ground-truth label resolves", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    expect(corpus.docs.length).toBeGreaterThanOrEqual(100);
    for (const q of corpus.queries) {
      expect(q.relevant.length).toBeGreaterThan(0);
      expect(q.requirement.length).toBeGreaterThan(20);
    }
  });

  it("gives every symbol a non-empty embedding text", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    expect(corpus.docs.every((d) => d.text.trim().length > 0)).toBe(true);
  });

  it("has unique query ids and unique doc ids", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    expect(new Set(corpus.queries.map((q) => q.id)).size).toBe(corpus.queries.length);
    expect(new Set(corpus.docs.map((d) => d.id)).size).toBe(corpus.docs.length);
  });

  // #1157's acceptance criteria, as executable assertions rather than prose in a
  // PR body. Each number is a FLOOR, so growing the corpus never fails the gate.
  it("meets #1157's size floor: >=90 requirements over >=500 symbols", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    expect(corpus.queries.length).toBeGreaterThanOrEqual(90);
    expect(corpus.symbols.length).toBeGreaterThanOrEqual(500);
  });

  it("indexes SQL symbols lexically but gives them NO vector, exactly as production does", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    const sql = corpus.symbols.filter((s) => s.kind === "table" || s.kind === "column");
    expect(sql.length).toBeGreaterThan(0);
    expect(sql.every((s) => s.language === "sql")).toBe(true);

    const searchableIds = new Set(corpus.searchable.map((s) => s.symbolId));
    const docIds = new Set(corpus.docs.map((d) => d.id));
    for (const s of sql) {
      expect(searchableIds.has(s.id)).toBe(true);
      expect(docIds.has(s.id)).toBe(false);
    }
    expect(corpus.searchable.length).toBeGreaterThan(corpus.docs.length);
  });

  it("declares strata on every query, and each declaration matches what deriveStrata computes", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    const byId = new Map(corpus.symbols.map((s) => [s.id, s]));
    for (const q of corpus.queries) {
      expect(q.strata, `${q.id} declares no strata`).not.toBeNull();
      const targets = q.relevant.map((id) => byId.get(id)!);
      expect(q.strata, `${q.id} strata are stale`).toEqual(deriveStrata(q.requirement, targets));
    }
  });

  it("meets #1157's stratum floors: >=20 snake (>=10 of them SQL) and >=10 keywordFree", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    const byId = new Map(corpus.symbols.map((s) => [s.id, s]));
    const snake = corpus.queries.filter((q) => q.strata?.naming === "snake");
    const snakeOnSql = snake.filter((q) =>
      q.relevant.every((id) => {
        const kind = byId.get(id)?.kind;
        return kind === "table" || kind === "column";
      }),
    );
    expect(snake.length).toBeGreaterThanOrEqual(20);
    expect(snakeOnSql.length).toBeGreaterThanOrEqual(10);
    expect(corpus.queries.filter((q) => q.strata?.keywordFree).length).toBeGreaterThanOrEqual(10);
    // Both cells of each dimension must be populated, or it is not a stratum.
    expect(corpus.queries.filter((q) => q.strata?.naming === "camel").length).toBeGreaterThan(0);
    expect(corpus.queries.filter((q) => q.strata?.keywordFree === false).length).toBeGreaterThan(0);
  });

  it("restates the hand-authored standard and the not-comparable warning in the corpus file", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    expect(corpus.spec.groundTruth).toMatch(/HAND-AUTHORED/);
    expect(corpus.spec.groundTruth).toMatch(/REQUIREMENT REGISTER, NOT KEYWORD REGISTER/);
    expect(corpus.spec.strata).toMatch(/naming/);
    expect(corpus.spec.strata).toMatch(/keywordFree/);
  });

  /**
   * The `snake ∧ lexically-matchable` cell is the ONLY cell #1159 can move, and half
   * of it is carried by SQL table names whose words appear verbatim in the
   * requirement. That is a real limit on what a gain there means, and it is the
   * sentence #1159 will be quoted on, so it is asserted rather than left to prose
   * that could be dropped in an edit (PR #1174 review).
   */
  it("discloses that #1159's cell is an upper bound, naming the five verbatim queries", async () => {
    const corpus = await loadEmbedRetrievalCorpus();
    expect(corpus.spec.strata).toMatch(/UPPER BOUND, NOT AN UNBIASED ESTIMATE/);
    for (const q of ["Q113", "Q114", "Q116", "Q117", "Q118"]) {
      expect(corpus.spec.strata, `${q} is not named in the upper-bound disclosure`).toContain(q);
    }
  });
});

/**
 * Provenance of the frozen snapshot.
 *
 * `snapshotCommit` is the line the corpus's whole value rests on: it is what makes a
 * committed score reproducible and what lets a reader check the ground truth against
 * real code. It is also trivially falsifiable, so it is checked rather than trusted.
 *
 * It shipped WRONG in the first cut of #1157 — the 18 files inherited from
 * `embedretrieval-01` carried 391f0f1's content under a declared commit of b7388a5d,
 * and 17 of them happened to be unchanged between the two, which is the kind of
 * near-miss that survives a spot check. `code-graph/hybrid-search.ts` was the one
 * that had moved (368 lines then, 518 at the declared commit).
 *
 * ## Why this asserts against the MANIFEST and not the working tree
 *
 * The first fix compared the snapshot to LIVE `server/src/lib/**`. That is the wrong
 * invariant (PR #1174 review): a frozen corpus must never claim to match HEAD.
 * Sub-issue C (#1159) edits `tokenizeCode` in `code-graph/hybrid-search.ts`, which is
 * snapshotted here, so that check would have gone red on a PR with no reason to look
 * at this file — and the reflexive repair is to resync the snapshot, which changes the
 * corpus between B's measurement and C's and destroys the before/after comparison the
 * corpus exists to provide. The same trap fires for any PR touching `auth/jwt.ts`,
 * `net/safe-fetch.ts`, `rag/embedder-registry.ts` or `mcp/http-transport.ts`.
 *
 * So the invariant asserted here is "the corpus matches what it SAYS it snapshotted",
 * which stays true as `main` moves on, and is the claim that actually matters.
 *
 * A `git show <snapshotCommit>:<path>` would express that directly, but
 * `actions/checkout` in `.github/workflows/ci.yml` sets no `fetch-depth`, so CI runs on
 * a depth-1 clone where that object is absent and the check would degrade to a
 * permanent silent skip. The committed manifest is therefore the always-on check, and
 * the git comparison runs as an extra wherever history is available.
 */
/**
 * #1382 — the provenance MAPPING, not the manifest that happened to be written from it.
 *
 * The manifest tests below read the committed JSON, so they pass whatever the writer
 * would do NEXT time. That is the gap this suite closes, and it was measured: reverting
 * `write-corpus-snapshot-manifest.ts` to its pre-#1382 blob left all 116 corpus tests
 * green, because deleting the redaction short-circuit changes nothing on disk — it
 * changes what the next regeneration would silently claim.
 */
describe("snapshotSourceFor", () => {
  it("maps a snapshot path to the repo path it was copied from", () => {
    expect(snapshotSourceFor("repo/auth/jwt.ts")).toBe("server/src/lib/auth/jwt.ts");
  });

  it("prefers the LONGEST matching prefix", () => {
    // A first-match walk over `repo` would map this to `server/src/lib/sql-lineage/`,
    // which does not exist.
    expect(snapshotSourceFor("repo/sql-lineage/api.py")).toBe("metis-sql-lineage/app/api.py");
  });

  it("claims nothing for a path under no snapshot source root", () => {
    expect(snapshotSourceFor("schema/schema.prisma")).toBeNull();
  });

  it("claims nothing for a REDACTED file, even though its prefix matches", () => {
    // The whole property. Without the short-circuit this returns
    // `server/src/lib/docs-gen/grounding/degraded-warnings.ts` and the next
    // regeneration writes a `source` whose bytes the redacted file cannot match.
    for (const rel of Object.keys(REDACTED_SNAPSHOT_FILES)) {
      const prefix = Object.keys(SNAPSHOT_SOURCE_ROOTS).find((p) => rel.startsWith(`${p}/`));
      expect(
        prefix,
        `${rel} is redacted but matches no source root, so this proves nothing`,
      ).toBeDefined();
      expect(snapshotSourceFor(rel)).toBeNull();
    }
  });

  it("agrees with the committed manifest on every entry", async () => {
    // Ties the mapping to the artefact: a manifest regenerated today must be
    // source-for-source identical to the one on disk.
    const manifest = await loadSnapshotManifest(dirFor(DEFAULT_CORPUS_ID));
    for (const [rel, entry] of Object.entries(manifest.files)) {
      expect(snapshotSourceFor(rel), `${rel}`).toBe(entry.source);
    }
  });
});

describe("embedretrieval-02 snapshot provenance", () => {
  const dir = corpusDir(DEFAULT_CORPUS_ID);

  const hash = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

  /** True when the declared commit is present in this clone (it is not in shallow CI). */
  const commitAvailable = (sha: string): boolean => {
    try {
      execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
        cwd: path.resolve(dir, "..", "..", ".."),
        stdio: "ignore",
      });
      return true;
    } catch {
      return false;
    }
  };

  it("declares the same commit and id as the corpus spec", async () => {
    const manifest = await loadSnapshotManifest(dir);
    const spec = (await loadEmbedRetrievalCorpus(dir)).spec;
    expect(manifest.corpusId).toBe(spec.id);
    expect(manifest.snapshotCommit).toBe(spec.snapshotCommit);
    expect(manifest.algorithm).toBe("sha256");
  });

  it("covers every snapshot file, with no entry for a file that is gone", async () => {
    const onDisk: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await fs.readdir(path.join(dir, rel), { withFileTypes: true })) {
        const next = `${rel}/${entry.name}`;
        if (entry.isDirectory()) await walk(next);
        else onDisk.push(next);
      }
    };
    await walk("repo");
    await walk("schema");

    const manifest = await loadSnapshotManifest(dir);
    expect(
      onDisk.filter((f) => !manifest.files[f]).sort(),
      "snapshot files with no manifest entry — regenerate with write-corpus-snapshot-manifest.ts",
    ).toEqual([]);
    expect(
      Object.keys(manifest.files)
        .filter((f) => !onDisk.includes(f))
        .sort(),
      "manifest entries with no snapshot file",
    ).toEqual([]);
  });

  /**
   * The always-on check. Needs no git, so it runs identically on a shallow CI clone,
   * and it fails when the SNAPSHOT drifts — never because `server/src/lib` moved on.
   */
  it("is byte-identical to the manifest it commits", async () => {
    const manifest = await loadSnapshotManifest(dir);
    const drifted: string[] = [];
    for (const [rel, entry] of Object.entries(manifest.files)) {
      const actual = hash(await fs.readFile(path.join(dir, rel)));
      if (actual !== entry.sha256) drifted.push(`${rel} — content drifted from the manifest`);
    }
    expect(
      drifted,
      `the corpus declares snapshotCommit ${manifest.snapshotCommit}, but these files no ` +
        `longer hash to the manifest recorded for it:\n  ${drifted.join("\n  ")}\n` +
        `Do NOT resync these to the working tree — that silently re-bases the corpus ` +
        `mid-epic. Restore the snapshot, or take a NEW corpus id with its own commit.`,
    ).toEqual([]);
  });

  /**
   * The manifest is generated from `git show <snapshotCommit>:<source>` rather than
   * from the snapshot files, so it cannot agree with drift already in the snapshot.
   * This re-checks that where history is available, which is what stops a future
   * regeneration from laundering a resync into a "verified" manifest.
   */
  it("records the hashes the declared commit actually has", async () => {
    const manifest = await loadSnapshotManifest(dir);
    if (!commitAvailable(manifest.snapshotCommit)) {
      // Shallow clone (CI default). The manifest check above already ran.
      expect(manifest.snapshotCommit).toMatch(/^[0-9a-f]{40}$/);
      return;
    }
    const repoRoot = path.resolve(dir, "..", "..", "..");
    const wrong: string[] = [];
    for (const [rel, entry] of Object.entries(manifest.files)) {
      if (entry.source === null) continue; // excerpt — no provenance claim, by design
      const atCommit = execFileSync("git", ["show", `${manifest.snapshotCommit}:${entry.source}`], {
        cwd: repoRoot,
        maxBuffer: 64 * 1024 * 1024,
      });
      if (hash(atCommit) !== entry.sha256) wrong.push(`${rel} (from ${entry.source})`);
    }
    expect(
      wrong,
      `the manifest claims hashes that ${manifest.snapshotCommit} does not have:\n  ` +
        `${wrong.join("\n  ")}`,
    ).toEqual([]);
  });

  it("claims provenance for every full-file copy and none for the excerpt or a redaction", async () => {
    const manifest = await loadSnapshotManifest(dir);
    const entries = Object.entries(manifest.files);
    // Exactly two kinds of entry may decline a provenance claim: the schema EXCERPT,
    // which is byte-identical to no file at any commit, and a file a redaction has
    // deliberately moved away from its source (#1382). Anything else with
    // `source: null` is a regeneration that lost a claim it should have kept.
    expect(
      entries
        .filter(([, e]) => e.source === null)
        .map(([f]) => f)
        .sort(),
    ).toEqual(["schema/schema.prisma", ...Object.keys(REDACTED_SNAPSHOT_FILES)].sort());
    // Python snapshots come from the sql-lineage sidecar, not from server/src/lib —
    // a first-match prefix walk mapped them to a path that does not exist.
    expect(manifest.files["repo/sql-lineage/api.py"]?.source).toBe("metis-sql-lineage/app/api.py");
    expect(manifest.files["repo/auth/jwt.ts"]?.source).toBe("server/src/lib/auth/jwt.ts");
  });

  /**
   * #1382 — the redaction is the reason a snapshot file may differ from its source,
   * so the redacted file must actually BE in the corpus and must carry the reason.
   * A key that names a path the corpus does not have is a stale waiver: it would keep
   * excusing a provenance claim for a file nobody can check.
   */
  it("names only real snapshot files as redacted, each with a reason", async () => {
    const manifest = await loadSnapshotManifest(dir);
    expect(Object.keys(REDACTED_SNAPSHOT_FILES).length).toBeGreaterThan(0);
    for (const [rel, reason] of Object.entries(REDACTED_SNAPSHOT_FILES)) {
      expect(
        manifest.files[rel],
        `${rel} is declared redacted but is not in the corpus`,
      ).toBeDefined();
      expect(reason.length, `${rel} declares no reason for its redaction`).toBeGreaterThan(30);
    }
  });
});
