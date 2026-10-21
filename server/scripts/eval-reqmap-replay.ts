/**
 * Issue #1097 — replay the #706 run-7 Miniflux requirements through the
 * analysis "affected code" path and score its links against committed labels
 * (`eval-data/reqmap-replay/miniflux-run7.json`).
 *
 * This is the measurement behind the #1097 link rules and confidence model. It
 * is LOCAL ONLY: it needs a database holding the two run-7 projects' code
 * graphs and a vector store holding their symbol embeddings, which a #706
 * walkthrough leaves behind and nothing commits. No model is called except the
 * local embedder (one query embedding per requirement); no paid model at all.
 *
 *   DATABASE_URL=file:/path/to/dev.db LANCEDB_PATH=/path/to/lancedb \
 *   EMBED_BACKEND=xenova TRANSFORMERS_CACHE=… HF_HUB_OFFLINE=1 \
 *   npx tsx scripts/eval-reqmap-replay.ts            # the arms table
 *   npx tsx scripts/eval-reqmap-replay.ts --detail   # every link, marked + or -
 *   npx tsx scripts/eval-reqmap-replay.ts --fit      # re-fit the confidence model
 *   npx tsx scripts/eval-reqmap-replay.ts --probes   # the PR #1095 review probes, both rankings
 *
 * Point DATABASE_URL at a COPY: the replay only reads, but Prisma opens the
 * file read-write.
 */
/* eslint-disable no-console -- a local CLI whose output is the table it prints */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapAffectedCodeCandidates } from "../src/lib/analysis/affected-code-context.js";
import { prisma } from "../src/lib/prisma.js";
import { getEmbedder } from "../src/lib/rag/embedder.js";
import { createSymbolVectorStore } from "../src/lib/code-graph/symbol-embedding-service.js";
import { tokenizeCode } from "../src/lib/code-graph/hybrid-search.js";
import {
  ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS,
  ANALYSIS_LINK_SEARCH_OPTIONS,
  MemoizingBm25CodeSymbolSearcher,
  denoiseRequirementQuery,
  sameWord,
  symbolNameTerms,
  type Bm25SearcherOptions,
} from "../src/lib/traceability/requirement-code-mapping.js";
import {
  HybridCodeSymbolSearcher,
  createRequirementCodeSearcher,
} from "../src/lib/traceability/requirement-code-searcher.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(__dirname, "../../eval-data/reqmap-replay/miniflux-run7.json");

interface ReplayRequirement {
  id: string;
  title: string;
  body: string;
  right: string[];
}
interface ReplayData {
  sets: Record<string, { projectId: string; requirements: ReplayRequirement[] }>;
}

interface Arm {
  label: string;
  semantic: boolean;
  /** Link options for [keyword fallback, hybrid]; absent ⇒ production's. */
  link?: [Bm25SearcherOptions, Bm25SearcherOptions];
}

const HYBRID_NO_FLOOR = { excludeTestCode: true, requireSubject: true };
const ARMS: Arm[] = [
  { label: "BM25 (fallback), production link rules", semantic: false },
  { label: "hybrid, production link rules", semantic: true },
  {
    label: "hybrid, the BM25 link rules (two terms)",
    semantic: true,
    link: [ANALYSIS_LINK_SEARCH_OPTIONS, ANALYSIS_LINK_SEARCH_OPTIONS],
  },
  ...[undefined, 0.05, 0.1, 0.15].map((floor): Arm => ({
    label: `hybrid, subject + tests${floor === undefined ? "" : ` + conf ≥ ${floor}`}`,
    semantic: true,
    link: [
      ANALYSIS_LINK_SEARCH_OPTIONS,
      floor === undefined ? HYBRID_NO_FLOOR : { ...HYBRID_NO_FLOOR, minConfidence: floor },
    ],
  })),
];

function searcherFor(semantic: boolean) {
  if (semantic) return createRequirementCodeSearcher(prisma);
  return new HybridCodeSymbolSearcher({
    bm25: new MemoizingBm25CodeSymbolSearcher(prisma),
    hybrid: { search: async () => [] },
    semanticModel: () => null,
  });
}

async function runArm(data: ReplayData, arm: Arm, detail: boolean) {
  const t = { links: 0, right: 0, covered: 0, empty: 0, total: 0, modes: new Set<string>() };
  for (const [name, set] of Object.entries(data.sets)) {
    const ctx = await mapAffectedCodeCandidates({
      projectId: set.projectId,
      changes: set.requirements.map((r) => ({
        requirementId: r.id,
        title: r.title,
        body: r.body,
        changeType: "added" as const,
        bodyDelta: r.body.length,
      })),
      maxSymbolsPerCandidate: 8,
      tokenBudget: 1_000_000,
      deps: { prisma, searcher: searcherFor(arm.semantic) },
      ...(arm.link ? { linkOptions: arm.link[0], hybridLinkOptions: arm.link[1] } : {}),
    });
    t.modes.add(ctx.result.retrievalMode ?? "none");
    ctx.result.candidates.forEach((c, i) => {
      const right = new Set(set.requirements[i]!.right);
      const hits = c.symbols.filter((s) => right.has(s.qualifiedName)).length;
      t.total++;
      t.links += c.symbols.length;
      t.right += hits;
      if (hits > 0) t.covered++;
      if (c.symbols.length === 0) t.empty++;
      if (detail) {
        console.log(`  ${name}/${c.id} ${c.title.slice(0, 70)}`);
        for (const s of c.symbols) {
          const mark = right.has(s.qualifiedName) ? "+" : "-";
          console.log(`    ${mark} ${s.qualifiedName} (${s.relation} ${s.confidence.toFixed(2)})`);
        }
      }
    });
  }
  console.log(
    `| ${arm.label} | ${[...t.modes].join("/")} | ${t.links} | ${t.right} | ` +
      `${(t.right / Math.max(1, t.links)).toFixed(2)} | ${t.covered} / ${t.total} | ${t.empty} |`,
  );
}

/**
 * The confidence model's data: for each requirement, the vector channel's top
 * 40 symbols with their cosine, the number of the requirement's (denoised)
 * words their name uses, and the label. Fits P(right) by logistic regression.
 */
async function fit(data: ReplayData) {
  const embedder = getEmbedder();
  const store = createSymbolVectorStore({ embedService: embedder, model: () => embedder.model });
  const rows: Array<{ shared: number; cos: number; right: boolean }> = [];
  for (const set of Object.values(data.sets)) {
    const symbols = await prisma.codeSymbol.findMany({
      where: { projectId: set.projectId },
      select: { id: true, name: true, qualifiedName: true, filePath: true },
    });
    const byId = new Map(symbols.map((s) => [s.id, s]));
    for (const r of set.requirements) {
      const query = `${r.title}\n\n${r.body}`.trim();
      const terms = new Set(tokenizeCode(denoiseRequirementQuery(query)));
      const { vectors } = await embedder.embed([query]);
      const right = new Set(r.right);
      for (const hit of await store.search(set.projectId, vectors[0]!, 40)) {
        const s = byId.get(hit.metadata.symbolId);
        if (!s) continue;
        const name = [...symbolNameTerms(s)];
        const shared = [...terms].filter((t) => name.some((n) => sameWord(n, t))).length;
        rows.push({
          shared: Math.min(shared, 3),
          cos: hit.score,
          right: right.has(s.qualifiedName),
        });
      }
    }
  }
  const sig = (z: number) => 1 / (1 + Math.exp(-z));
  const logistic = (features: (r: (typeof rows)[number]) => number[]) => {
    let w = new Array(features(rows[0]!).length + 1).fill(0) as number[];
    for (let it = 0; it < 20000; it++) {
      const g = new Array(w.length).fill(0) as number[];
      for (const r of rows) {
        const x = [1, ...features(r)];
        const p = sig(x.reduce((acc, xi, j) => acc + xi * w[j]!, 0));
        x.forEach((xi, j) => (g[j]! += ((r.right ? 1 : 0) - p) * xi));
      }
      w = w.map((wj, j) => wj + (0.5 * g[j]!) / rows.length);
    }
    return w.map((x) => x.toFixed(3));
  };
  console.log(`${rows.length} links, ${rows.filter((r) => r.right).length} right`);
  console.log(
    "lexical [intercept, perSharedTerm]:",
    logistic((r) => [r.shared]),
  );
  console.log(
    "semantic [intercept, perSharedTerm, perCosineStep(0.05 above 0.60)]:",
    logistic((r) => [r.shared, (r.cos - 0.6) / 0.05]),
  );
}

/**
 * The PR #1095 review probes on the journey project, through the production
 * path with each ranking. Fails (exit 1) if a probe's known mislink comes back.
 */
const PROBES: Array<{ text: string; never: string }> = [
  { text: "Add a button to terminate all sessions", never: "InlineKeyboardButton" },
  {
    text: "Add a button in the web client to terminate all sessions",
    never: "InlineKeyboardButton",
  },
  { text: "Ability to force IPv4 or IPv6 per feed", never: "ForceRefreshInterval" },
  {
    text: "Force IPv4 or IPv6 per feed in the internal model",
    never: "ForceRefreshInterval",
  },
];

async function probes(data: ReplayData) {
  const projectId = data.sets.j1!.projectId;
  let failed = false;
  for (const semantic of [false, true]) {
    const ctx = await mapAffectedCodeCandidates({
      projectId,
      changes: PROBES.map((p, i) => ({
        requirementId: `P${i + 1}`,
        title: p.text,
        body: p.text,
        changeType: "added" as const,
        bodyDelta: p.text.length,
      })),
      maxSymbolsPerCandidate: 8,
      tokenBudget: 1_000_000,
      deps: { prisma, searcher: searcherFor(semantic) },
    });
    console.log(`ranking: ${ctx.result.retrievalMode ?? "none"}`);
    ctx.result.candidates.forEach((c, i) => {
      const bad = c.symbols.some((s) => s.qualifiedName.endsWith(`::${PROBES[i]!.never}`));
      failed ||= bad;
      const shown = c.symbols.map(
        (s) => `${s.qualifiedName.split("::").pop()}@${s.confidence.toFixed(2)}`,
      );
      console.log(
        `  ${bad ? "FAIL" : "ok  "} ${PROBES[i]!.text} → ${shown.join(", ") || "(none)"}`,
      );
    });
  }
  if (failed) process.exitCode = 1;
}

async function main() {
  const data = JSON.parse(await readFile(DATA, "utf8")) as ReplayData;
  if (process.argv.includes("--fit")) {
    await fit(data);
  } else if (process.argv.includes("--probes")) {
    await probes(data);
  } else {
    const detail = process.argv.includes("--detail");
    console.log(
      "| arm | ranking | links | right | precision | requirements with a right link | no link |",
    );
    console.log("|---|---|---|---|---|---|---|");
    for (const arm of ARMS) await runArm(data, arm, detail);
    console.log(
      `\nProduction link options: fallback ${JSON.stringify(ANALYSIS_LINK_SEARCH_OPTIONS)}, ` +
        `hybrid ${JSON.stringify(ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS)}`,
    );
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("eval-reqmap-replay failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
