/**
 * #1799 — `pnpm eval:materialize <corpus>`: materialize a localization corpus as
 * real, ingested METIS projects for agent-based eval arms (#1755, #1759).
 *
 *   pnpm eval:materialize localization-01-miniflux-heldout
 *   pnpm eval:materialize localization-02-fixture-portfolio
 *   pnpm eval:materialize impact-recall-01-jpetstore   # #1823: the table guard's repository
 *
 * Per manifest repository: a shallow clone at the pinned commit, a project with a
 * GitHub repository connector, the normal code-graph ingest (SQL lineage off, as
 * the committed rows were built) and the local embedder's symbol vectors. All of
 * it lives in the gitignored `eval-data/.materialized/`:
 *
 *   eval.db                 the SQLite eval database (DATABASE_URL)
 *   clones/<connectorId>/   the clones (REPO_CLONE_DIR)
 *   lancedb/                the symbol vectors (LANCEDB_PATH)
 *   <corpus>.state.json     project and connector ids, commit SHAs, the env above
 *
 * The script sets `DATABASE_URL`, `REPO_CLONE_DIR` and `LANCEDB_PATH` itself and
 * asserts the database Prisma bound to is the eval one, never `server/dev.db`. It
 * reads no `.env`. The embedder is the local one: `EMBED_BACKEND=xenova` with
 * `Alibaba-NLP/gte-modernbert-base` unless `EMBED_MODEL` says otherwise. No hosted
 * model is called.
 *
 * Idempotent: a re-run with the same commits builds and writes nothing. Either
 * way the materialized symbol set is checked against the committed
 * `symbols.json.gz`, and a difference fails the run, listed.
 *
 * #1823 — `impact-recall-01-jpetstore` is a hand-authored graph with no
 * committed rows: its schema-bearing repository (`TABLE_GUARD_REPO`) is
 * materialized instead, and checked for every file the fixture maps to it.
 */
/* eslint-disable no-console -- a local CLI whose output is what it did */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import {
  LOCALIZATION_CORPORA,
  loadLocalizationCorpus,
  type LocalizationCorpusName,
  type LocalizationRepo,
} from "../src/lib/eval/localization/corpus.js";
import {
  assertCommitSha,
  assertEvalDatabase,
  connectorIdFor,
  EVAL_USER_EMAIL,
  materializeCorpus,
  materializeLayout,
  parseGithubRepoUrl,
  projectSlugFor,
  readMaterializedState,
  statePathFor,
  type MaterializeDeps,
  type MaterializedRepo,
} from "../src/lib/eval/localization/materialize.js";
import {
  requiredRepoFiles,
  TABLE_GUARD_CORPUS,
  TABLE_GUARD_REPO,
} from "../src/lib/eval/localization/table-guard-source.js";

const SERVER_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_EMBED_MODEL = "Alibaba-NLP/gte-modernbert-base";

function corpusArg(): LocalizationCorpusName | typeof TABLE_GUARD_CORPUS {
  const [name] = process.argv.slice(2).filter((a) => a !== "--");
  if (name === TABLE_GUARD_CORPUS) return name;
  if (!name || !(LOCALIZATION_CORPORA as readonly string[]).includes(name)) {
    throw new Error(
      `usage: pnpm eval:materialize <${[...LOCALIZATION_CORPORA, TABLE_GUARD_CORPUS].join("|")}>`,
    );
  }
  return name as LocalizationCorpusName;
}

/** `git` with an argument array: no shell, and every argument is validated first. */
function git(args: string[]): void {
  execFileSync("git", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
}

async function main(): Promise<void> {
  const corpusName = corpusArg();
  const layout = materializeLayout();

  // Every path the run writes is fixed here, before anything that reads them is imported.
  process.env.DATABASE_URL = layout.databaseUrl;
  process.env.REPO_CLONE_DIR = layout.cloneRoot;
  process.env.LANCEDB_PATH = layout.lancedbPath;
  process.env.EMBED_BACKEND ??= "xenova";
  process.env.EMBED_MODEL ??= DEFAULT_EMBED_MODEL;
  assertEvalDatabase(process.env.DATABASE_URL, layout);

  await fs.mkdir(layout.cloneRoot, { recursive: true });
  await fs.mkdir(layout.lancedbPath, { recursive: true });
  execFileSync("pnpm", ["exec", "prisma", "migrate", "deploy"], {
    cwd: SERVER_DIR,
    env: process.env,
    stdio: ["ignore", "pipe", "inherit"],
  });

  const { prisma, boundDatabaseUrl } = await import("../src/lib/prisma.js");
  // The assertion the issue asks for: Prisma is bound to the eval file, whatever
  // the caller's environment said.
  assertEvalDatabase(boundDatabaseUrl, layout);
  if (boundDatabaseUrl !== layout.databaseUrl) {
    throw new Error(`Prisma is bound to ${boundDatabaseUrl}, not ${layout.databaseUrl}`);
  }
  const { activeVectorBackend } = await import("../src/lib/rag/vector-store.js");
  if (activeVectorBackend() !== "lancedb") {
    throw new Error(
      `symbol vectors must go to the eval LanceDB directory; unset VECTOR_STORE / AI_OFFLINE (backend: ${activeVectorBackend()})`,
    );
  }
  const { resolveBackendKey } = await import("../src/lib/rag/embedder-registry.js");
  if (resolveBackendKey() !== "xenova") {
    throw new Error(
      `the local embedder is required (EMBED_BACKEND=xenova), not ${resolveBackendKey()}`,
    );
  }
  const { getEmbedder } = await import("../src/lib/rag/embedder.js");
  const embedModel = getEmbedder().model;
  const { ingestCodeGraph } = await import("../src/lib/code-graph/ingest.js");
  const { embedProjectSymbols, dropProjectSymbols, symbolCoverage } =
    await import("../src/lib/code-graph/symbol-embedding-service.js");
  const { inspectClone } = await import("../src/lib/connectors/repo/clone-health.js");
  const { resolveRepoClonePath } = await import("../src/lib/connectors/repo/clone-path.js");

  // #1823 — the table guard's corpus is checked for its required files, not committed rows.
  const expected: Pick<
    Parameters<typeof materializeCorpus>[0],
    "manifest" | "committedRows" | "requiredFiles"
  > =
    corpusName === TABLE_GUARD_CORPUS
      ? await (async () => {
          const fixtureMod = await import("../src/lib/eval/impact-recall/fixture.js");
          const fixture = await fixtureMod.loadImpactRecallFixture(
            fixtureMod.resolveCorpusDir(TABLE_GUARD_CORPUS),
          );
          return {
            manifest: { id: TABLE_GUARD_CORPUS, repos: [TABLE_GUARD_REPO] },
            requiredFiles: requiredRepoFiles(fixture),
          };
        })()
      : await (async () => {
          const corpus = await loadLocalizationCorpus(corpusName);
          return { manifest: corpus.manifest, committedRows: corpus.symbols };
        })();

  async function evalUserId(): Promise<string> {
    const user = await prisma.user.upsert({
      where: { email: EVAL_USER_EMAIL },
      create: {
        email: EVAL_USER_EMAIL,
        displayName: "eval-materialize",
        username: "eval-materialize",
      },
      update: {},
    });
    return user.id;
  }

  async function cloneAt(dir: string, url: string, sha: string): Promise<void> {
    const found = await inspectClone(dir);
    if (found.state === "healthy" && found.headSha === sha) return;
    await fs.rm(dir, { recursive: true, force: true });
    await fs.mkdir(dir, { recursive: true });
    git(["init", "--quiet", dir]);
    git(["-C", dir, "remote", "add", "origin", url]);
    git(["-C", dir, "fetch", "--quiet", "--depth", "1", "origin", sha]);
    git(["-C", dir, "-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", sha]);
    const head = (await inspectClone(dir)).headSha;
    if (head !== sha) throw new Error(`clone of ${url} is at ${head}, not ${sha}`);
  }

  async function deleteProjectBySlug(slug: string): Promise<void> {
    const old = await prisma.project.findUnique({ where: { slug }, select: { id: true } });
    if (!old) return;
    await dropProjectSymbols(old.id);
    await prisma.project.delete({ where: { id: old.id } });
  }

  async function probe(entry: MaterializedRepo): Promise<string | null> {
    if (entry.cloneDir !== resolveRepoClonePath(entry.connectorId)) return "clone path moved";
    const project = await prisma.project.findUnique({ where: { id: entry.projectId } });
    if (!project) return "project missing from the eval database";
    const graph = await prisma.codeGraph.findFirst({
      where: { projectId: entry.projectId, repoConnectionId: entry.connectorId },
      select: { commitSha: true },
    });
    if (graph?.commitSha !== entry.sha) return `graph at ${graph?.commitSha ?? "nothing"}`;
    const clone = await inspectClone(entry.cloneDir);
    if (clone.state !== "healthy" || clone.headSha !== entry.sha) {
      return `clone ${clone.state} at ${clone.headSha ?? "no commit"}`;
    }
    const coverage = await symbolCoverage(entry.projectId);
    if (coverage.totalSymbols === 0 || coverage.modelCounts[embedModel] !== coverage.totalSymbols) {
      return `symbols not all embedded with ${embedModel}`;
    }
    return null;
  }

  async function build(repo: LocalizationRepo): Promise<MaterializedRepo> {
    const { owner, name } = parseGithubRepoUrl(repo.url);
    assertCommitSha(repo.sha);
    const slug = projectSlugFor(corpusName, repo.name);
    const connectorId = connectorIdFor(corpusName, repo.name);
    const cloneDir = resolveRepoClonePath(connectorId);
    const t0 = performance.now();
    await deleteProjectBySlug(slug);
    await cloneAt(cloneDir, repo.url, repo.sha);
    const tClone = performance.now();
    const userId = await evalUserId();
    const project = await prisma.project.create({
      data: { name: slug, slug, createdById: userId, status: "active" },
    });
    try {
      await prisma.repoConnection.create({
        data: {
          id: connectorId,
          projectId: project.id,
          label: `${repo.name} @ ${repo.ref}`,
          provider: "github",
          ownerOrOrg: owner,
          repoName: name,
          defaultBranch: repo.ref,
          isPrimary: true,
          status: "connected",
          createdById: userId,
        },
      });
      const stats = await ingestCodeGraph(prisma, {
        projectId: project.id,
        rootDir: cloneDir,
        repoConnectionId: connectorId,
        commitSha: repo.sha,
        incremental: false,
        triggeredByUserId: userId,
        // The committed rows were built with lineage off (eval-data/README.md).
        sqlLineageOverride: false,
      });
      const tIngest = performance.now();
      const embedded = await embedProjectSymbols(project.id);
      const coverage = await symbolCoverage(project.id);
      if (coverage.modelCounts[embedModel] !== coverage.totalSymbols) {
        throw new Error(`${repo.name}: not every symbol was embedded with ${embedModel}`);
      }
      const tEmbed = performance.now();
      const s = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
      console.log(
        `${repo.name}@${repo.sha.slice(0, 8)}: ${stats.filesParsed} files, ${stats.symbolsUpserted} symbols, ` +
          `${embedded.embedded} embedded — clone ${s(tClone - t0)}, ingest ${s(tIngest - tClone)}, embed ${s(tEmbed - tIngest)}`,
      );
      return {
        name: repo.name,
        url: repo.url,
        sha: repo.sha,
        projectId: project.id,
        connectorId,
        cloneDir,
        symbols: await prisma.codeSymbol.count({ where: { projectId: project.id } }),
      };
    } catch (err) {
      await dropProjectSymbols(project.id);
      await prisma.project.delete({ where: { id: project.id } });
      throw err;
    }
  }

  const deps: MaterializeDeps = {
    probe,
    build,
    async drop(entry) {
      await deleteProjectBySlug(projectSlugFor(corpusName, entry.name));
      // Re-derived, not read from the state file: a path-safe id under the clone root.
      const cloneDir = resolveRepoClonePath(connectorIdFor(corpusName, entry.name));
      await fs.rm(cloneDir, { recursive: true, force: true });
    },
    async readSymbols(projectId) {
      return prisma.codeSymbol.findMany({
        where: { projectId },
        select: { filePath: true, qualifiedName: true },
      });
    },
    async writeState(state) {
      await fs.writeFile(
        statePathFor(layout, corpusName),
        `${JSON.stringify(state, null, 2)}\n`,
        "utf8",
      );
    },
    now: () => new Date(),
    log: (line) => console.log(line),
  };

  try {
    const result = await materializeCorpus({
      ...expected,
      state: await readMaterializedState(corpusName, layout),
      env: {
        databaseUrl: layout.databaseUrl,
        cloneRoot: layout.cloneRoot,
        lancedbPath: layout.lancedbPath,
        embedModel,
      },
      deps,
    });
    console.log(
      result.changed
        ? `${corpusName}: materialized → ${statePathFor(layout, corpusName)}`
        : `${corpusName}: already materialized, nothing to do`,
    );
    for (const r of result.state.repos) {
      console.log(
        `  ${r.name}: project ${r.projectId}, connector ${r.connectorId}, ${r.symbols} symbols`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("eval:materialize failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
