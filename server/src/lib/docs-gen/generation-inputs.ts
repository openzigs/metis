/** Pre-generation scoped inventory; rechecked before committing generated content. */
import { prisma } from "../prisma.js";
import { assertEvidencePolicy, type EvidencePolicy } from "./evidence-policy.js";
import { filterPrimaryEvidence } from "./evidence-filter.js";
import { fingerprintInputs, inputHash, type GenerationInputSnapshot } from "./regeneration-plan.js";
import {
  PHASE1_PROMPT_VERSION,
  buildDocsGenProvider,
  resolvePhase2Router,
} from "./holistic-synthesizer.js";
import { resolveFactsMaxOutputTokens, resolveSectionMaxOutputTokens } from "./output-caps.js";
import { resolveGroundingK } from "./grounding/grounding-retrieval.js";
import { readdir, readFile } from "node:fs/promises";
import { loadRepositorySources, resolveSourcePath } from "./repository-sources.js";
import { SQL_SCAN_DIR_CAP } from "./module-grouping.js";
import { loadAIConfig } from "../ai/config.js";
import { isJunkSourcePath } from "@metis/shared";

/** Canonicalize objects, not arrays: prompt/selection order can be meaningful. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function hash(value: unknown): string {
  return inputHash(canonical(value));
}

function json(value: string | null): unknown {
  try {
    return JSON.parse(value ?? "null") as unknown;
  } catch {
    return value;
  }
}

// Match holistic SQL discovery's directory exclusions and bounded file mining.
const SQL_SKIP = new Set([
  "node_modules",
  ".git",
  "test",
  "tests",
  "generated",
  "build",
  "target",
  ".next",
  "dist",
  "vendor",
]);

export async function captureGenerationInputs(
  doc: {
    projectId: string;
    title: string;
    docType?: string;
    scope: string;
    scopeFilter: string;
    evidencePolicy: string | null;
  },
  policy: EvidencePolicy,
): Promise<GenerationInputSnapshot> {
  assertEvidencePolicy(policy, doc.projectId);
  // Never silently broaden a repository snapshot when its resolved graph is missing.
  if (doc.scope === "repository" && (!policy.repoConnectorId || !policy.codeGraphId)) {
    throw new Error("Repository generation inputs require a resolved graph");
  }
  const where = {
    projectId: doc.projectId,
    ...(policy.codeGraphId ? { codeGraphId: policy.codeGraphId } : {}),
  };
  const [symbols, edges, chunks, project] = await Promise.all([
    prisma.codeSymbol.findMany({
      where,
      orderBy: [{ filePath: "asc" }, { startLine: "asc" }],
      include: { graph: { select: { repoConnectionId: true } } },
    }),
    prisma.codeEdge.findMany({
      where: { ...where, kind: { in: ["calls", "imports", "references"] } },
      include: {
        fromSymbol: { include: { graph: { select: { repoConnectionId: true } } } },
        toSymbol: { include: { graph: { select: { repoConnectionId: true } } } },
      },
    }),
    prisma.knowledgeChunk.findMany({
      where: {
        projectId: doc.projectId,
        document: {
          deletedAt: null,
          indexState: "indexed",
          ...(policy.repoConnectorId
            ? {
                OR: [
                  { filename: { startsWith: `connector:repo:${policy.repoConnectorId}:` } },
                  { id: { in: [...policy.sharedDocumentIds] } },
                ],
              }
            : {}),
        },
      },
      include: { document: { select: { filename: true } } },
    }),
    prisma.project.findFirst({
      where: { id: doc.projectId, deletedAt: null },
      select: { name: true, description: true },
    }),
  ]);
  const items: Record<string, string> = {};
  // A multiset preserves duplicate declarations/edges/chunks without depending
  // on transient row IDs or query order. Never overwrite a same-name entry.
  const entries = new Map<string, string[]>();
  const add = (kind: string, identity: unknown, value: unknown): void => {
    const key = `${kind}:${hash(identity)}`;
    const bucket = entries.get(key) ?? [];
    bucket.push(hash(value));
    entries.set(key, bucket);
  };
  const repositories = await loadRepositorySources(where);
  const symbolKey = (s: (typeof symbols)[number]): unknown[] => [
    s.graph.repoConnectionId,
    s.codeGraphId,
    s.filePath,
    s.qualifiedName,
    s.kind,
    s.startLine,
    s.endLine,
  ];
  const scopedSymbols = symbols.filter((s) => !isJunkSourcePath(s.filePath));
  const byId = new Map(scopedSymbols.map((s) => [s.id, symbolKey(s)]));
  for (const symbol of scopedSymbols) {
    add("symbol", symbolKey(symbol), [
      symbol.name,
      symbol.contentHash,
      symbol.language,
      symbol.source,
    ]);
  }
  for (const edge of edges) {
    add(
      "edge",
      [
        symbolKey(edge.fromSymbol),
        edge.kind,
        edge.toSymbol ? symbolKey(edge.toSymbol) : null,
        edge.toQualifiedName,
        edge.filePath,
        edge.line,
      ],
      [json(edge.metadata), edge.source],
    );
  }
  // Same eligible rationale pool as Phase 1; chunk IDs to avoid SQL bind limits.
  const ids = [...byId.keys()];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const findings = await prisma.finding.findMany({
      where: {
        agentResult: { analysis: { projectId: doc.projectId } },
        category: { in: ["rationale", "rationale-todo"] },
        symbolId: { in: ids.slice(offset, offset + 500) },
      },
    });
    for (const finding of findings) {
      add("finding", [byId.get(finding.symbolId!), finding.category, finding.title], {
        body: finding.body,
        evidence: json(finding.evidence),
        severity: finding.severity,
        derivation: finding.derivation,
        confidence: finding.confidence,
        verificationStatus: finding.verificationStatus,
      });
    }
  }
  for (const repository of repositories.values()) {
    const identity = [repository.repoConnectorId, repository.codeGraphId];
    add("repository", identity, repository.root !== null);
    if (!repository.root) continue;
    const root = repository.root;
    const files = new Set(
      scopedSymbols.filter((s) => s.codeGraphId === repository.codeGraphId).map((s) => s.filePath),
    );
    const read = async (filename: string, kind: string): Promise<string | null> => {
      let content: string | null = null;
      try {
        content = await readFile(await resolveSourcePath(root, filename), "utf8");
      } catch {
        // Match synthesis's unavailable-source behavior, including unsafe paths.
      }
      add(kind, [identity, filename], content);
      return content;
    };
    // Phase 1 hashes entire files, not just indexed symbol snippets. Read each once.
    for (const filename of files) await read(filename, "source");
    const scanned = new Set<string>();
    const scan = async (relative: string): Promise<string[]> => {
      if (scanned.has(relative)) return [];
      scanned.add(relative);
      try {
        const children = await readdir(await resolveSourcePath(root, relative), {
          withFileTypes: true,
        });
        // Every .sql file in full, as Phase 1 mines them (no file or char cap).
        for (const entry of children.filter(
          (e) => e.isFile() && e.name.toLowerCase().endsWith(".sql"),
        )) {
          await read(relative ? `${relative}/${entry.name}` : entry.name, "sql");
        }
        return children
          .filter((e) => e.isDirectory() && !SQL_SKIP.has(e.name) && !e.name.startsWith("."))
          .map((e) => (relative ? `${relative}/${e.name}` : e.name));
      } catch {
        return [];
      }
    };
    // Every SQL-only directory holistic synthesis mines, within the same
    // per-repository safety bound: exhausting one clone must not hide inputs
    // from another. No arbitrary non-SQL source-tree contents read.
    // A read index, never `queue.shift()` (which copies a large array on every
    // call), and a loop, never `push(...children)` (spreading one directory's
    // children as call arguments overflows the stack past ~130k) — #191.
    const queue = [""];
    for (let head = 0; head < queue.length && head < SQL_SCAN_DIR_CAP; head++) {
      for (const child of await scan(queue[head])) queue.push(child);
    }
    // Symbol-derived modules can lie beyond the SQL discovery budget; include
    // their directories (and virtual mega-module dirs) without recursive scans.
    for (const filename of files) {
      await scan(filename.split("/").slice(0, -1).join("/"));
      await scan(filename.replace(/\.[^.]+$/, ""));
    }
  }
  // Include the eligible retrieval pool: additions can change top-k selection
  // even when previously selected citations remain unchanged.
  const allowed = await filterPrimaryEvidence(
    chunks.map((chunk) => ({
      chunkId: chunk.id,
      documentId: chunk.documentId,
      filename: chunk.document.filename,
      text: chunk.text,
      position: chunk.position,
      metadata: chunk.metadata,
      embeddingModel: chunk.embeddingModel,
      chunkerIdentity: chunk.chunkerIdentity,
    })),
    policy,
  );
  for (const chunk of allowed) {
    add(
      "evidence",
      [chunk.documentId, chunk.filename, chunk.position],
      [chunk.text, json(chunk.metadata), chunk.embeddingModel, chunk.chunkerIdentity],
    );
  }
  if (policy.allowWebResearch) {
    const { getLatestWebResearch } = await import("../analysis/analysis-service.js");
    const research = await getLatestWebResearch(doc.projectId);
    items.web = hash(research?.digests ?? []);
  }
  const phase1 = buildDocsGenProvider(1, resolveFactsMaxOutputTokens());
  const phase2 = resolvePhase2Router(resolveSectionMaxOutputTokens());
  // Persist only the hash, never environment values or provider credentials.
  const tuningEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([key]) => /^(DOCS_GEN_|DOCS_GROUNDING_|DOCS_FAITHFULNESS_)/.test(key))
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  const bundle = (b: Omit<typeof phase1, "effectiveConfigHash">) => ({
    tuning: b.tuning,
    provider: b.provider.key,
    model: b.provider.model,
    offline: b.provider.offline,
    supportsCaching: b.supportsCaching,
    factsCharCap: b.factsCharCap,
  });
  items.settings = hash({
    title: doc.title,
    docType: doc.docType,
    scope: doc.scope,
    scopeFilter: JSON.parse(doc.scopeFilter),
    policy: json(doc.evidencePolicy),
    resolvedPolicy: { ...policy, sharedDocumentIds: [...policy.sharedDocumentIds].sort() },
    project,
    config: loadAIConfig(),
    phase1: bundle(phase1),
    phase2: bundle(phase2.primary),
    hybrid: phase2.hybrid
      ? { local: bundle(phase2.hybrid.local), escalation: bundle(phase2.hybrid.escalation) }
      : null,
    endpoints: {
      gateway: process.env.BEDROCK_GATEWAY_URL ?? process.env.BEDROCK_GATEWAY_BASE_URL,
      local: process.env.LOCAL_GEMMA_BASE_URL,
      anthropic: process.env.ANTHROPIC_BASE_URL,
    },
    factsMaxTokens: resolveFactsMaxOutputTokens(phase1.tuning.phase1Model),
    sectionMaxTokens: resolveSectionMaxOutputTokens(phase2.primary.tuning.phase2Model),
    groundingK: resolveGroundingK(),
    prompt: PHASE1_PROMPT_VERSION,
    tuningEnv,
  });
  for (const [key, values] of entries) {
    values.sort().forEach((value, index) => {
      items[`${key}:${index}`] = value;
    });
  }
  const snapshot = fingerprintInputs(items);
  Object.freeze(snapshot.items);
  return Object.freeze(snapshot);
}
