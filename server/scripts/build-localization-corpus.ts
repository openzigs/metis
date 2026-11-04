/**
 * #1753 — rebuild the inputs of the localization eval (`pnpm eval:localization`).
 *
 * Two steps, run by hand when a corpus is created or its snapshot moves. Neither
 * calls a model.
 *
 *   # 1. Ingest each repository with the REAL code-graph ingest into a scratch
 *   #    database and write the symbol rows the arms search (gzipped JSON).
 *   DATABASE_URL=file:/abs/scratch.db pnpm exec prisma migrate deploy
 *   DATABASE_URL=file:/abs/scratch.db pnpm exec tsx scripts/build-localization-corpus.ts \
 *     symbols --corpus localization-01-miniflux-heldout --root miniflux=/abs/miniflux-2.3.3
 *
 *   # 2. Fill an upstream-PR item's ground truth from the merged PR's file list:
 *   #    tests and documentation (the rules seeding uses, `change-seeds.ts`), files
 *   #    the change added, and files the code graph does not hold are excluded,
 *   #    each with its reason. Reads `gh api`; writes manifest.json.
 *   pnpm exec tsx scripts/build-localization-corpus.ts ground-truth \
 *     --corpus localization-01-miniflux-heldout
 *
 * `symbols` refuses anything but a `file:` DATABASE_URL and a database that
 * already holds a project, like `bench-ingest.ts`: the dev database is a `file:`
 * URL too, so the scheme alone is no guard. It deletes what it created.
 */
/* eslint-disable no-console -- a local CLI whose output is what it did */
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";
import {
  classifyChangedFiles,
  decodeSymbolsFile,
  graphFilesOf,
  parseSlurpedPages,
  resolveLocalizationCorpusDir,
  resolveSymbolsPath,
  type ChangedFile,
  type LocalizationCorpusManifest,
  type LocalizationSymbolRow,
  type LocalizationSymbolsFile,
} from "../src/lib/eval/localization/corpus.js";

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  });
  return out;
}

async function readManifest(dir: string): Promise<LocalizationCorpusManifest> {
  return JSON.parse(
    await fs.readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as LocalizationCorpusManifest;
}

async function writeManifest(dir: string, manifest: LocalizationCorpusManifest): Promise<void> {
  await fs.writeFile(
    path.join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
}

/** Step 1: ingest each `--root <repo>=<dir>` and write the symbol rows. */
async function buildSymbols(corpus: string): Promise<void> {
  const dir = resolveLocalizationCorpusDir(corpus);
  const manifest = await readManifest(dir);
  const roots = new Map(
    args("root").map((r) => {
      const eq = r.indexOf("=");
      return [r.slice(0, eq), path.resolve(r.slice(eq + 1))] as const;
    }),
  );
  for (const repo of manifest.repos) {
    if (!roots.has(repo.name)) throw new Error(`--root ${repo.name}=<dir> is required`);
  }
  const dbUrl = process.env.DATABASE_URL ?? "";
  if (!dbUrl.startsWith("file:")) {
    throw new Error("DATABASE_URL must be a scratch file: URL — refusing to touch a real database");
  }
  const { prisma } = await import("../src/lib/prisma.js");
  const { ingestCodeGraph } = await import("../src/lib/code-graph/ingest.js");
  if ((await prisma.project.count()) > 0) {
    await prisma.$disconnect();
    throw new Error("DATABASE_URL already holds a project — point it at an empty scratch database");
  }
  const tag = `localization-${Date.now()}`;
  const user = await prisma.user.create({
    data: { email: `${tag}@corpus.invalid`, displayName: tag, username: tag },
  });
  const rows: LocalizationSymbolRow[] = [];
  try {
    for (const repo of manifest.repos) {
      const project = await prisma.project.create({
        data: { name: `${tag}-${repo.name}`, slug: `${tag}-${repo.name}`, createdById: user.id },
      });
      try {
        const stats = await ingestCodeGraph(prisma, {
          projectId: project.id,
          rootDir: roots.get(repo.name)!,
          commitSha: repo.sha,
          incremental: false,
          triggeredByUserId: user.id,
          sqlLineageOverride: false,
        });
        const symbols = await prisma.codeSymbol.findMany({
          where: { projectId: project.id },
          select: {
            name: true,
            qualifiedName: true,
            kind: true,
            language: true,
            filePath: true,
            startLine: true,
            endLine: true,
            signature: true,
            docComment: true,
            package: true,
          },
        });
        const texts = await prisma.codeSymbolEmbedding.findMany({
          where: { projectId: project.id },
          select: { text: true, symbol: { select: { qualifiedName: true, startLine: true } } },
        });
        const textOf = new Map(
          texts.map((t) => [`${t.symbol.qualifiedName}@${t.symbol.startLine}`, t.text]),
        );
        // #1135 — the lineage writers, which seeding keeps out of a read-path bug's edits.
        const writerEdges = await prisma.codeEdge.findMany({
          where: { projectId: project.id, kind: { in: ["writes", "persists-to"] } },
          select: { fromSymbol: { select: { qualifiedName: true, startLine: true } } },
        });
        const writers = new Set(
          writerEdges.map((e) => `${e.fromSymbol.qualifiedName}@${e.fromSymbol.startLine}`),
        );
        // Ids are assigned in a stable order so BM25 tie-breaks reproduce run to run.
        symbols.sort(
          (a, b) =>
            a.filePath.localeCompare(b.filePath) ||
            a.startLine - b.startLine ||
            a.qualifiedName.localeCompare(b.qualifiedName),
        );
        symbols.forEach((s, i) => {
          const key = `${s.qualifiedName}@${s.startLine}`;
          const text = textOf.get(key);
          rows.push({
            id: `${repo.name}#${String(i + 1).padStart(5, "0")}`,
            repo: repo.name,
            name: s.name,
            qualifiedName: s.qualifiedName,
            kind: s.kind,
            language: s.language,
            filePath: s.filePath,
            startLine: s.startLine,
            endLine: s.endLine,
            ...(s.signature ? { signature: s.signature } : {}),
            ...(s.docComment ? { docComment: s.docComment } : {}),
            ...(s.package ? { package: s.package } : {}),
            ...(text ? { embeddingText: text } : {}),
            ...(writers.has(key) ? { writesData: true } : {}),
          });
        });
        console.log(
          `${repo.name}@${repo.sha.slice(0, 8)}: ${stats.filesParsed} files, ${symbols.length} symbols`,
        );
      } finally {
        await prisma.project.delete({ where: { id: project.id } });
      }
    }
  } finally {
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
  const file: LocalizationSymbolsFile = {
    note:
      "Built by `server/scripts/build-localization-corpus.ts symbols` (#1753): the real " +
      "code-graph ingest of each repository at its pinned commit, read back from CodeSymbol " +
      "and CodeSymbolEmbedding.",
    repos: manifest.repos,
    rows,
  };
  const out = resolveSymbolsPath(dir, manifest);
  await fs.writeFile(out, gzipSync(Buffer.from(JSON.stringify(file), "utf8"), { level: 9 }));
  console.log(`${rows.length} symbol rows → ${out}`);
}

/** The merged PR's changed files, through `gh api` (no shell: arguments are an array). */
function prFiles(repoUrl: string, pr: number): ChangedFile[] {
  if (!Number.isInteger(pr) || pr <= 0) throw new Error(`not a PR number: ${pr}`);
  const slug = new URL(repoUrl).pathname.replace(/^\/|\.git$/g, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(slug)) throw new Error(`not an owner/repo URL: ${repoUrl}`);
  const out = execFileSync(
    "gh",
    ["api", `repos/${slug}/pulls/${pr}/files?per_page=100`, "--paginate", "--slurp"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  return parseSlurpedPages<ChangedFile>(out);
}

/** Step 2: fill each upstream-PR item's ground truth from its merged PR. */
async function buildGroundTruth(corpus: string): Promise<void> {
  const dir = resolveLocalizationCorpusDir(corpus);
  const manifest = await readManifest(dir);
  const symbols = decodeSymbolsFile(await fs.readFile(resolveSymbolsPath(dir, manifest)));
  const graphFiles = graphFilesOf(symbols.rows);
  const repo = manifest.repos[0]!;
  for (const item of manifest.items) {
    if (item.source.kind !== "upstream-pr") continue;
    const { expectedFiles, excludedFiles } = classifyChangedFiles(
      repo.name,
      prFiles(repo.url, item.source.pr),
      graphFiles,
    );
    item.expectedFiles = expectedFiles;
    item.expectedRepos = expectedFiles.length > 0 ? [repo.name] : [];
    item.excludedFiles = excludedFiles;
    console.log(`${item.id}: ${expectedFiles.length} scored, ${excludedFiles.length} excluded`);
  }
  await writeManifest(dir, manifest);
}

async function main(): Promise<void> {
  const [command] = process.argv.slice(2);
  const corpus = args("corpus")[0];
  if (!corpus) throw new Error("--corpus <name> is required");
  if (command === "symbols") await buildSymbols(corpus);
  else if (command === "ground-truth") await buildGroundTruth(corpus);
  else
    throw new Error("usage: build-localization-corpus.ts <symbols|ground-truth> --corpus <name>");
}

main().catch((err) => {
  console.error("build-localization-corpus failed:", err);
  process.exit(1);
});
