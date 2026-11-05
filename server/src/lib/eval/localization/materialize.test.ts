import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalizationRepo, LocalizationSymbolRow } from "./corpus.js";
import {
  MATERIALIZED_STATE_VERSION,
  assertCommitSha,
  assertEvalDatabase,
  compareSymbolSets,
  connectorIdFor,
  defaultMaterializeRoot,
  devDatabasePath,
  formatSymbolSetDiffs,
  materializeCorpus,
  materializeLayout,
  parseGithubRepoUrl,
  parseMaterializedState,
  planMaterialization,
  projectSlugFor,
  readMaterializedState,
  statePathFor,
  symbolSetDiffIsEmpty,
  type MaterializeDeps,
  type MaterializeEnv,
  type MaterializedRepo,
  type MaterializedState,
  type SymbolKeyRow,
} from "./materialize.js";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ROOT = path.resolve("/tmp/metis-eval-materialized");
const LAYOUT = materializeLayout(ROOT);
const ENV: MaterializeEnv = {
  databaseUrl: LAYOUT.databaseUrl,
  cloneRoot: LAYOUT.cloneRoot,
  lancedbPath: LAYOUT.lancedbPath,
  embedModel: "Alibaba-NLP/gte-modernbert-base",
};
const CORPUS = "localization-02-fixture-portfolio" as const;

function repo(name: string, sha = SHA_A): LocalizationRepo {
  return { name, url: `https://github.com/o/${name}`, ref: "main", sha };
}

function row(repoName: string, filePath: string, qualifiedName: string): LocalizationSymbolRow {
  return {
    id: `${repoName}#${qualifiedName}`,
    repo: repoName,
    name: qualifiedName,
    qualifiedName,
    kind: "function",
    language: "typescript",
    filePath,
    startLine: 1,
    endLine: 2,
  };
}

function entry(name: string, sha = SHA_A): MaterializedRepo {
  return {
    name,
    url: `https://github.com/o/${name}`,
    sha,
    projectId: `p-${name}`,
    connectorId: connectorIdFor(CORPUS, name),
    cloneDir: path.join(LAYOUT.cloneRoot, connectorIdFor(CORPUS, name)),
    symbols: 2,
  };
}

function state(
  repos: MaterializedRepo[],
  over: Partial<MaterializedState> = {},
): MaterializedState {
  return {
    version: MATERIALIZED_STATE_VERSION,
    corpus: CORPUS,
    ...ENV,
    materializedAt: "2026-11-04T00:00:00.000Z",
    repos,
    ...over,
  };
}

const manifest = (...repos: LocalizationRepo[]) => ({ id: CORPUS, repos });

describe("layout and guards", () => {
  it("puts everything under the eval directory, beside the corpora", () => {
    expect(LAYOUT).toEqual({
      root: ROOT,
      databasePath: path.join(ROOT, "eval.db"),
      databaseUrl: `file:${path.join(ROOT, "eval.db")}`,
      cloneRoot: path.join(ROOT, "clones"),
      lancedbPath: path.join(ROOT, "lancedb"),
    });
    expect(statePathFor(LAYOUT, CORPUS)).toBe(path.join(ROOT, `${CORPUS}.state.json`));
    expect(defaultMaterializeRoot().endsWith(path.join("eval-data", ".materialized"))).toBe(true);
    expect(devDatabasePath().endsWith(path.join("server", "dev.db"))).toBe(true);
    expect(materializeLayout().root).toBe(defaultMaterializeRoot());
  });

  it("accepts the eval database", () => {
    expect(() =>
      assertEvalDatabase(LAYOUT.databaseUrl, LAYOUT, "/repo/server/dev.db"),
    ).not.toThrow();
  });

  it("refuses the dev database, even when it sits inside the eval directory", () => {
    const dev = path.join(ROOT, "dev.db");
    expect(() => assertEvalDatabase(`file:${dev}`, LAYOUT, dev)).toThrow(/dev database/);
    expect(() =>
      assertEvalDatabase(
        `file:${devDatabasePath()}`,
        materializeLayout(path.dirname(devDatabasePath())),
      ),
    ).toThrow(/dev database/);
  });

  it("refuses a non-file URL, a relative path and a path outside the eval directory", () => {
    expect(() => assertEvalDatabase("postgresql://u@h/db", LAYOUT)).toThrow(/file: URL/);
    expect(() => assertEvalDatabase("file:./dev.db", LAYOUT)).toThrow(/absolute/);
    expect(() => assertEvalDatabase("file:/elsewhere/eval.db", LAYOUT)).toThrow(/outside/);
    expect(() => assertEvalDatabase(`file:${ROOT}`, LAYOUT)).toThrow(/outside/);
  });

  it("names the connector and project after the corpus and repository", () => {
    expect(connectorIdFor(CORPUS, "orders")).toBe(`eval-${CORPUS}-orders`);
    expect(projectSlugFor(CORPUS, "orders")).toBe(`eval-${CORPUS}-orders`);
    expect(() => connectorIdFor(CORPUS, "../x")).toThrow(/path-safe/);
  });

  it("accepts only a github.com repository URL", () => {
    expect(parseGithubRepoUrl("https://github.com/miniflux/v2")).toEqual({
      owner: "miniflux",
      name: "v2",
    });
    expect(parseGithubRepoUrl("https://github.com/o/r.git")).toEqual({ owner: "o", name: "r" });
    for (const bad of [
      "http://github.com/o/r",
      "https://gitlab.com/o/r",
      "https://github.com/o/r/tree/main",
      "https://github.com/-o/r",
      "https://github.com/o/-r",
      "--upload-pack=x",
    ]) {
      expect(() => parseGithubRepoUrl(bad), bad).toThrow(/github/);
    }
  });

  it("accepts only a full commit SHA", () => {
    expect(() => assertCommitSha(SHA_A)).not.toThrow();
    expect(() => assertCommitSha("main")).toThrow(/SHA/);
    expect(() => assertCommitSha("A".repeat(40))).toThrow(/SHA/);
  });
});

describe("compareSymbolSets", () => {
  const committed: SymbolKeyRow[] = [
    { filePath: "src/a.ts", qualifiedName: "a" },
    { filePath: "src/a.ts", qualifiedName: "a2" },
    { filePath: "src/b.ts", qualifiedName: "b" },
  ];

  it("passes when the files and qualified names match, paths normalized", () => {
    const d = compareSymbolSets("app", committed, [
      { filePath: "./src/b.ts", qualifiedName: "b" },
      { filePath: "src\\a.ts", qualifiedName: "a2" },
      { filePath: "src/a.ts", qualifiedName: "a" },
    ]);
    expect(symbolSetDiffIsEmpty(d)).toBe(true);
  });

  it("catches a missing file", () => {
    const d = compareSymbolSets("app", committed, committed.slice(0, 2));
    expect(d.missingFiles).toEqual(["app:src/b.ts"]);
    expect(d.extraFiles).toEqual([]);
    // The file's symbols are reported once, as the file.
    expect(d.missingSymbols).toEqual([]);
    expect(symbolSetDiffIsEmpty(d)).toBe(false);
  });

  it("catches an extra file", () => {
    const d = compareSymbolSets("app", committed, [
      ...committed,
      { filePath: "src/new.ts", qualifiedName: "n" },
    ]);
    expect(d.extraFiles).toEqual(["app:src/new.ts"]);
    expect(d.missingFiles).toEqual([]);
    expect(d.extraSymbols).toEqual([]);
    expect(symbolSetDiffIsEmpty(d)).toBe(false);
  });

  it("catches a renamed symbol in a shared file", () => {
    const d = compareSymbolSets("app", committed, [
      { filePath: "src/a.ts", qualifiedName: "a" },
      { filePath: "src/a.ts", qualifiedName: "renamed" },
      { filePath: "src/b.ts", qualifiedName: "b" },
    ]);
    expect(d.missingSymbols).toEqual(["app:src/a.ts#a2"]);
    expect(d.extraSymbols).toEqual(["app:src/a.ts#renamed"]);
    expect(d.missingFiles).toEqual([]);
  });

  it("formats every non-empty difference, capped per list", () => {
    const ok = compareSymbolSets("ok", committed, committed);
    const bad = compareSymbolSets("app", committed, [
      { filePath: "src/a.ts", qualifiedName: "a" },
      { filePath: "src/x.ts", qualifiedName: "x" },
      { filePath: "src/y.ts", qualifiedName: "y" },
    ]);
    const text = formatSymbolSetDiffs([ok, bad], 1);
    expect(text).not.toContain("ok:");
    expect(text).toContain("app:");
    expect(text).toContain("missing from the materialized graph (1):");
    expect(text).toContain("- app:src/b.ts");
    expect(text).toContain("not in the committed rows (2):");
    expect(text).toContain("- app:src/x.ts");
    expect(text).toContain("… and 1 more");
    expect(text).not.toContain("app:src/y.ts");
    expect(text).toContain("symbols committed, not materialized (1):");
    expect(formatSymbolSetDiffs([ok])).toBe("");
  });
});

describe("state file", () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("round-trips a state and refuses a malformed one", () => {
    const s = state([entry("orders")]);
    expect(parseMaterializedState(JSON.stringify(s))).toEqual(s);
    const broken: Array<[unknown, RegExp]> = [
      [null, /not an object/],
      [{ ...s, version: "1" }, /no version/],
      [{ ...s, embedModel: 3 }, /no embedModel/],
      [{ ...s, repos: {} }, /no repos/],
      [{ ...s, repos: [{ ...entry("orders"), projectId: undefined }] }, /no projectId/],
      [{ ...s, repos: [{ ...entry("orders"), symbols: "2" }] }, /symbol count/],
      [{ ...s, repos: [null] }, /no name/],
    ];
    for (const [value, re] of broken) {
      expect(() => parseMaterializedState(JSON.stringify(value))).toThrow(re);
    }
  });

  it("reads null when a corpus was never materialized, and the state when it was", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "materialize-"));
    const layout = materializeLayout(dir);
    expect(await readMaterializedState(CORPUS, layout)).toBeNull();
    const s = state([entry("orders")]);
    await writeFile(statePathFor(layout, CORPUS), JSON.stringify(s));
    expect(await readMaterializedState(CORPUS, layout)).toEqual(s);
  });

  it("rethrows a read error that is not a missing file", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "materialize-"));
    const layout = materializeLayout(dir);
    await mkdir(statePathFor(layout, CORPUS));
    await expect(readMaterializedState(CORPUS, layout)).rejects.toThrow();
  });
});

describe("planMaterialization", () => {
  const m = manifest(repo("orders"), repo("billing"));

  it("builds everything when nothing is materialized", () => {
    const plan = planMaterialization(m, null, ENV);
    expect(plan.repos.map((r) => [r.action, r.action === "build" && r.reason])).toEqual([
      ["build", "not materialized"],
      ["build", "not materialized"],
    ]);
    expect(plan.drop).toEqual([]);
  });

  it("keeps a repository recorded at the manifest's commit", () => {
    const plan = planMaterialization(m, state([entry("orders"), entry("billing")]), ENV);
    expect(plan.repos.every((r) => r.action === "keep")).toBe(true);
  });

  it.each([
    [{ version: 0 }, "another version"],
    [{ corpus: "localization-01-miniflux-heldout" }, "state is for"],
    [{ databaseUrl: "file:/x/eval.db" }, "moved"],
    [{ cloneRoot: "/x" }, "moved"],
    [{ lancedbPath: "/x" }, "moved"],
    [{ embedModel: "other" }, "embedded with other"],
  ] as Array<[Partial<MaterializedState>, string]>)(
    "rebuilds everything when the state does not fit (%o)",
    (over, reason) => {
      const plan = planMaterialization(m, state([entry("orders"), entry("billing")], over), ENV);
      for (const r of plan.repos) {
        expect(r.action).toBe("build");
        if (r.action === "build") expect(r.reason).toContain(reason);
      }
      expect(plan.drop).toEqual([]);
    },
  );

  it("rebuilds only the repository whose commit, URL or record changed, and drops a removed one", () => {
    const moved = { ...entry("orders"), url: "https://github.com/x/orders" };
    const plan = planMaterialization(
      manifest(repo("orders"), repo("billing", SHA_B), repo("notify")),
      state([moved, entry("billing"), entry("gone")]),
      ENV,
    );
    expect(plan.repos.map((r) => (r.action === "build" ? r.reason : "keep"))).toEqual([
      "repository URL changed",
      `materialized at ${SHA_A}, not ${SHA_B}`,
      "not materialized",
    ]);
    expect(plan.drop.map((r) => r.name)).toEqual(["gone"]);
  });
});

/** A fake of the script's I/O: a database of projects and their symbols. */
function fakeDeps(
  symbolsByRepo: Record<string, SymbolKeyRow[]>,
  intact: Record<string, string | null> = {},
) {
  const calls: string[] = [];
  const written: MaterializedState[] = [];
  const projects = new Map<string, string>();
  const deps: MaterializeDeps = {
    async probe(e) {
      calls.push(`probe ${e.name}`);
      return intact[e.name] ?? null;
    },
    async build(r) {
      calls.push(`build ${r.name}`);
      const e = { ...entry(r.name, r.sha), projectId: `new-${r.name}` };
      projects.set(e.projectId, r.name);
      return e;
    },
    async drop(e) {
      calls.push(`drop ${e.name}`);
    },
    async readSymbols(projectId) {
      const name = projects.get(projectId) ?? projectId.replace(/^p-/, "");
      return symbolsByRepo[name] ?? [];
    },
    async writeState(s) {
      written.push(s);
    },
    now: () => new Date("2026-11-04T12:00:00.000Z"),
    log: () => {},
  };
  return { deps, calls, written };
}

describe("materializeCorpus", () => {
  const committed = [
    row("orders", "src/a.ts", "a"),
    row("orders", "src/b.ts", "b"),
    row("billing", "src/c.ts", "c"),
  ];
  const graph = {
    orders: [
      { filePath: "src/a.ts", qualifiedName: "a" },
      { filePath: "src/b.ts", qualifiedName: "b" },
    ],
    billing: [{ filePath: "src/c.ts", qualifiedName: "c" }],
  };
  const m = manifest(repo("orders"), repo("billing"));

  it("builds every repository from nothing, checks it and records it", async () => {
    const { deps, calls, written } = fakeDeps(graph);
    const result = await materializeCorpus({
      manifest: m,
      committedRows: committed,
      state: null,
      env: ENV,
      deps,
    });
    expect(result.changed).toBe(true);
    expect(calls).toEqual(["build orders", "build billing"]);
    expect(written).toHaveLength(1);
    expect(written[0]).toEqual({
      version: MATERIALIZED_STATE_VERSION,
      corpus: CORPUS,
      ...ENV,
      materializedAt: "2026-11-04T12:00:00.000Z",
      repos: [
        { ...entry("orders"), projectId: "new-orders" },
        { ...entry("billing"), projectId: "new-billing" },
      ],
    });
    expect(result.state).toBe(written[0]);
  });

  it("is a no-op when the state, database and clones are intact: nothing built or written", async () => {
    const { deps, calls, written } = fakeDeps(graph);
    const s = state([entry("orders"), entry("billing")]);
    const result = await materializeCorpus({
      manifest: m,
      committedRows: committed,
      state: s,
      env: ENV,
      deps,
    });
    expect(result).toEqual({ changed: false, state: s });
    expect(calls).toEqual(["probe orders", "probe billing"]);
    expect(written).toEqual([]);
  });

  it("rebuilds a recorded repository the probe finds broken, and keeps the rest", async () => {
    const { deps, calls, written } = fakeDeps(graph, { billing: "project missing" });
    const result = await materializeCorpus({
      manifest: m,
      committedRows: committed,
      state: state([entry("orders"), entry("billing")]),
      env: ENV,
      deps,
    });
    expect(calls).toEqual(["probe orders", "probe billing", "build billing"]);
    expect(result.changed).toBe(true);
    expect(written[0]!.repos.map((r) => r.projectId)).toEqual(["p-orders", "new-billing"]);
  });

  it("drops a repository the manifest no longer names, and records the change", async () => {
    const { deps, calls, written } = fakeDeps(graph);
    await materializeCorpus({
      manifest: m,
      committedRows: committed,
      state: state([entry("orders"), entry("billing"), entry("gone")]),
      env: ENV,
      deps,
    });
    expect(calls[0]).toBe("drop gone");
    expect(written[0]!.repos.map((r) => r.name)).toEqual(["orders", "billing"]);
  });

  it("fails on a symbol-set difference, lists it, and leaves nothing it built behind", async () => {
    const { deps, calls, written } = fakeDeps({
      orders: [
        { filePath: "src/a.ts", qualifiedName: "a" },
        { filePath: "src/extra.ts", qualifiedName: "x" },
      ],
      billing: graph.billing,
    });
    await expect(
      materializeCorpus({ manifest: m, committedRows: committed, state: null, env: ENV, deps }),
    ).rejects.toThrow(/does not match[\s\S]*- orders:src\/b\.ts[\s\S]*- orders:src\/extra\.ts/);
    expect(calls).toEqual(["build orders", "build billing", "drop orders", "drop billing"]);
    expect(written).toEqual([]);
  });

  it("fails a no-op run whose graph no longer matches, without dropping what it did not build", async () => {
    const { deps, calls, written } = fakeDeps({ orders: graph.orders, billing: [] });
    await expect(
      materializeCorpus({
        manifest: m,
        committedRows: committed,
        state: state([entry("orders"), entry("billing")]),
        env: ENV,
        deps,
      }),
    ).rejects.toThrow(/billing:src\/c\.ts/);
    expect(calls).toEqual(["probe orders", "probe billing"]);
    expect(written).toEqual([]);
  });

  it("fails when the committed rows hold nothing for a repository", async () => {
    const { deps } = fakeDeps(graph);
    await expect(
      materializeCorpus({
        manifest: m,
        committedRows: committed.filter((r) => r.repo !== "billing"),
        state: null,
        env: ENV,
        deps,
      }),
    ).rejects.toThrow(/nothing for billing/);
  });

  it("#1823: checks a corpus with no committed rows for its required files instead", async () => {
    const { deps, calls, written } = fakeDeps(graph);
    const result = await materializeCorpus({
      manifest: m,
      requiredFiles: ["orders:src/b.ts", "billing:src/c.ts"],
      state: null,
      env: ENV,
      deps,
    });
    expect(result.changed).toBe(true);
    expect(calls).toEqual(["build orders", "build billing"]);
    expect(written).toHaveLength(1);
  });

  it("#1823: fails on a required file the graph lacks, lists it, and drops what it built", async () => {
    const { deps, calls, written } = fakeDeps(graph);
    await expect(
      materializeCorpus({
        manifest: m,
        requiredFiles: ["orders:src/a.ts", "orders:src/gone.ts", "billing:src/c.ts"],
        state: null,
        env: ENV,
        deps,
      }),
    ).rejects.toThrow(/does not match its required files[\s\S]*- orders:src\/gone\.ts/);
    expect(calls).toEqual(["build orders", "build billing", "drop orders", "drop billing"]);
    expect(written).toEqual([]);
  });

  it("#1823: fails when no required file names a repository, and takes exactly one check", async () => {
    const { deps } = fakeDeps(graph);
    await expect(
      materializeCorpus({
        manifest: m,
        requiredFiles: ["orders:src/a.ts"],
        state: null,
        env: ENV,
        deps,
      }),
    ).rejects.toThrow(/no required file names billing/);
    for (const both of [{ committedRows: committed, requiredFiles: ["orders:src/a.ts"] }, {}]) {
      const fresh = fakeDeps(graph);
      await expect(
        materializeCorpus({ manifest: m, ...both, state: null, env: ENV, deps: fresh.deps }),
      ).rejects.toThrow(/exactly one/);
      expect(fresh.calls).toEqual([]);
    }
  });

  it("refuses a repository URL or commit that is not safe to hand to git, before any I/O", async () => {
    for (const bad of [
      { ...repo("orders"), url: "--upload-pack=touch /tmp/x" },
      { ...repo("orders"), sha: "HEAD" },
    ]) {
      const { deps, calls } = fakeDeps(graph);
      await expect(
        materializeCorpus({
          manifest: manifest(bad),
          committedRows: committed,
          state: null,
          env: ENV,
          deps,
        }),
      ).rejects.toThrow(/github|SHA/);
      expect(calls).toEqual([]);
    }
  });
});
