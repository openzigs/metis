/**
 * Unified architecture doc generator (Epic #544 / Issue #551).
 *
 * Generates a single unified architecture document from all repos in a product,
 * showing how services relate, API contracts, data flow, and deployment topology.
 */
import type { ProductEdgeEvidence } from "@metis/shared";

export interface ProductRepoInfo {
  repoConnectionId: string;
  repoName: string;
  ownerOrOrg: string;
  role?: string | null;
  defaultBranch: string;
}

export interface ProductEdgeInfo {
  sourceRepoId: string;
  targetRepoId: string;
  edgeType: string;
  confidence: number;
  evidence: ProductEdgeEvidence[];
  sourceFile?: string | null;
  targetFile?: string | null;
}

/**
 * #1732 — a repo at the far end of a cross-product edge (#1724): another
 * product's, so it is named, never described. A readable one is labelled
 * `owner/name (Product)`; one the caller cannot read carries the restricted
 * relabel, and its evidence is withheld.
 */
export interface ExternalRepoInfo {
  repoConnectionId: string;
  label: string;
  restricted: boolean;
}

/**
 * #1732 — what a document calls a repo the person who generated it could not
 * read. A document is shared, so it does not say "you".
 */
export const RESTRICTED_REPO_LABEL = "A restricted repository";

export interface UnifiedDocInput {
  productName: string;
  productDescription: string;
  repos: ProductRepoInfo[];
  /** Edges between the product's repos, and (#1732) to the `externalRepos`. */
  edges: ProductEdgeInfo[];
  /** #1732 — the far ends of the product's cross-product edges. */
  externalRepos?: ExternalRepoInfo[];
}

/** #1732 — how a document names, draws and attributes the repos its edges touch. */
export interface RepoNaming {
  /** The short name: the repo name, or an external repo's label. */
  name(repoConnectionId: string): string;
  /** The full name: `owner/name`, or an external repo's label. */
  full(repoConnectionId: string): string;
  /** A Mermaid node id. An external repo's is positional, so no id is disclosed. */
  nodeId(repoConnectionId: string): string;
  /** Whether it is a repo the caller cannot read. */
  restricted(repoConnectionId: string): boolean;
}

/** Make text safe for a Markdown table cell (and a Mermaid label): no `|`, quote or line break. */
export function docCell(text: string | null | undefined): string {
  // Stored evidence is JSON written by older code and by hand: a field may be missing.
  return String(text ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/[\r\n]+/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/"/g, "'");
}

export function repoNaming(
  repos: readonly ProductRepoInfo[],
  externalRepos: readonly ExternalRepoInfo[] = [],
): RepoNaming {
  const own = new Map(repos.map((r) => [r.repoConnectionId, r]));
  const external = new Map(externalRepos.map((r, i) => [r.repoConnectionId, { ...r, i }]));
  return {
    name: (id) => own.get(id)?.repoName ?? external.get(id)?.label ?? "unknown",
    full: (id) => {
      const repo = own.get(id);
      if (repo) return `${repo.ownerOrOrg}/${repo.repoName}`;
      return external.get(id)?.label ?? "unknown";
    },
    nodeId: (id) => {
      const ext = external.get(id);
      return ext ? `__ext${ext.i}` : sanitizeMermaidId(id);
    },
    restricted: (id) => external.get(id)?.restricted === true,
  };
}

/**
 * #1732 (#1727) — the repo an evidence entry's file is in: the one it records,
 * or, for evidence detected before it recorded one, the end whose file it is.
 * A topic's or a table's evidence names both ends, the source's first.
 */
export function evidenceRepoId(
  edge: Pick<
    ProductEdgeInfo,
    "sourceRepoId" | "targetRepoId" | "evidence" | "sourceFile" | "targetFile"
  >,
  index: number,
): string {
  const ev = edge.evidence[index];
  if (ev.repoConnectionId) return ev.repoConnectionId;
  const bothEnds =
    edge.evidence.length === 2 &&
    (ev.matchType === "event_topic" || ev.matchType === "shared_table");
  if (bothEnds) return index === 0 ? edge.sourceRepoId : edge.targetRepoId;
  return ev.filePath === edge.targetFile && ev.filePath !== edge.sourceFile
    ? edge.targetRepoId
    : edge.sourceRepoId;
}

/**
 * #1732 — an edge's evidence, each entry with its repo. An edge to a repo the
 * caller cannot read shows none: its own side's evidence can name the far repo
 * ("Spec references billing").
 */
export function visibleEvidence(
  edge: ProductEdgeInfo,
  naming: RepoNaming,
): Array<ProductEdgeEvidence & { repoConnectionId: string }> {
  if (naming.restricted(edge.sourceRepoId) || naming.restricted(edge.targetRepoId)) return [];
  return edge.evidence.map((ev, i) => ({ ...ev, repoConnectionId: evidenceRepoId(edge, i) }));
}

export interface GeneratedDoc {
  title: string;
  content: string;
  metadata: {
    generatedAt: string;
    repoCount: number;
    edgeCount: number;
    provenance: Array<{ repo: string; file?: string; commitSha?: string }>;
  };
}

/**
 * Generate a unified architecture document for a product.
 * This produces a structured Markdown document with Mermaid diagrams.
 */
export function generateUnifiedArchitectureDoc(input: UnifiedDocInput): GeneratedDoc {
  const { productName, productDescription, repos, edges } = input;
  const externalRepos = input.externalRepos ?? [];
  const naming = repoNaming(repos, externalRepos);

  const sections: string[] = [];

  // Title
  sections.push(`# ${productName} — Architecture Documentation\n`);

  // System Overview
  sections.push("## System Overview\n");
  sections.push(
    productDescription ||
      `${productName} is a multi-repository product composed of ${repos.length} services/repos.\n`,
  );
  sections.push("");

  // Service Map (Mermaid)
  sections.push("## Service Map\n");
  sections.push(generateServiceMapDiagram(repos, edges, externalRepos, naming));
  sections.push("");
  // #1732 — say which nodes are another product's.
  const externalIds = new Set(externalRepos.map((r) => r.repoConnectionId));
  const crossEdges = edges.filter(
    (e) => externalIds.has(e.sourceRepoId) || externalIds.has(e.targetRepoId),
  ).length;
  if (crossEdges > 0) {
    sections.push(
      `_${crossEdges === 1 ? "1 link reaches" : `${crossEdges} links reach`} a repository of another product, drawn dashed and named \`owner/name (Product)\`._`,
    );
    sections.push("");
  }

  // API Contracts
  sections.push("## API Contracts\n");
  sections.push(generateApiContractsSection(edges, naming));
  sections.push("");

  // Data Flow
  sections.push("## Data Flow\n");
  sections.push(generateDataFlowDiagram(edges, naming));
  sections.push("");

  // Cross-Cutting Concerns
  sections.push("## Cross-Cutting Concerns\n");
  sections.push(generateCrossCuttingSection(repos));
  sections.push("");

  // Provenance
  sections.push("## Provenance\n");
  const provenance = generateProvenance(edges, naming);
  sections.push(provenance.markdown);
  sections.push("");

  const content = sections.join("\n");

  return {
    title: `${productName} — Architecture Documentation`,
    content,
    metadata: {
      generatedAt: new Date().toISOString(),
      repoCount: repos.length,
      edgeCount: edges.length,
      provenance: provenance.items,
    },
  };
}

function generateServiceMapDiagram(
  repos: ProductRepoInfo[],
  edges: ProductEdgeInfo[],
  externalRepos: ExternalRepoInfo[],
  naming: RepoNaming,
): string {
  const lines: string[] = ["```mermaid", "graph TB"];

  // Add nodes
  for (const repo of repos) {
    // Each part escaped on its own: the `\\n` between them is Mermaid's line break.
    const name = docCell(repo.repoName);
    const label = repo.role ? `${name}\\n[${docCell(repo.role)}]` : name;
    lines.push(`    ${naming.nodeId(repo.repoConnectionId)}["${label}"]`);
  }
  // #1732 — another product's repos, the far ends of cross-product edges.
  for (const ext of externalRepos) {
    lines.push(`    ${naming.nodeId(ext.repoConnectionId)}["${docCell(ext.label)}"]`);
  }

  // Add edges
  for (const edge of edges) {
    const label = `${edge.edgeType} (${(edge.confidence * 100).toFixed(0)}%)`;
    lines.push(
      `    ${naming.nodeId(edge.sourceRepoId)} -->|"${label}"| ${naming.nodeId(edge.targetRepoId)}`,
    );
  }

  if (externalRepos.length > 0) {
    lines.push("    classDef external stroke-dasharray: 5 5");
    lines.push(
      `    class ${externalRepos.map((r) => naming.nodeId(r.repoConnectionId)).join(",")} external`,
    );
  }

  lines.push("```");
  return lines.join("\n");
}

function generateDataFlowDiagram(edges: ProductEdgeInfo[], naming: RepoNaming): string {
  // Only include call/produces/consumes edges for data flow
  const dataEdges = edges.filter((e) => ["calls", "produces", "consumes"].includes(e.edgeType));

  if (dataEdges.length === 0) {
    return "_No data flow edges detected._\n";
  }

  const lines: string[] = ["```mermaid", "sequenceDiagram"];

  // Create participants
  const participants = new Set<string>();
  for (const edge of dataEdges) {
    participants.add(edge.sourceRepoId);
    participants.add(edge.targetRepoId);
  }
  for (const pid of participants) {
    lines.push(`    participant ${naming.nodeId(pid)} as ${docCell(naming.name(pid))}`);
  }

  // Add interactions
  for (const edge of dataEdges) {
    const src = naming.nodeId(edge.sourceRepoId);
    const tgt = naming.nodeId(edge.targetRepoId);
    const arrow = edge.edgeType === "calls" ? "->>" : "-->>";
    lines.push(`    ${src}${arrow}${tgt}: ${edge.edgeType}`);
  }

  lines.push("```");
  return lines.join("\n");
}

function generateApiContractsSection(edges: ProductEdgeInfo[], naming: RepoNaming): string {
  const callEdges = edges.filter((e) => e.edgeType === "calls");

  if (callEdges.length === 0) {
    return "_No API contract edges detected._\n";
  }

  const lines: string[] = [
    "| Source | Target | Confidence | Evidence |",
    "|--------|--------|-----------|----------|",
  ];

  for (const edge of callEdges) {
    const evidenceSummary = visibleEvidence(edge, naming)
      .map((e) => e.snippet || e.pattern)
      .join("; ");
    lines.push(
      `| ${docCell(naming.name(edge.sourceRepoId))} | ${docCell(naming.name(edge.targetRepoId))} | ${(edge.confidence * 100).toFixed(0)}% | ${docCell(evidenceSummary)} |`,
    );
  }

  return lines.join("\n");
}

function generateCrossCuttingSection(repos: ProductRepoInfo[]): string {
  const lines: string[] = ["| Service | Role | Repository |", "|---------|------|------------|"];

  for (const repo of repos) {
    lines.push(
      `| ${repo.repoName} | ${repo.role ?? "unspecified"} | ${repo.ownerOrOrg}/${repo.repoName} |`,
    );
  }

  return lines.join("\n");
}

/**
 * Every evidence file, credited to the repo it is in (#1732, #1727: it was
 * credited to the edge's source, so a topic's publisher file read as the
 * subscriber's). Evidence from a repo the caller cannot read is left out.
 */
export function generateProvenance(
  edges: ProductEdgeInfo[],
  naming: RepoNaming,
): { markdown: string; items: Array<{ repo: string; file?: string; commitSha?: string }> } {
  const items: Array<{ repo: string; file?: string; commitSha?: string }> = [];
  const lines: string[] = ["| Repo | File | Evidence |", "|------|------|----------|"];

  const seen = new Set<string>();
  for (const edge of edges) {
    for (const ev of visibleEvidence(edge, naming)) {
      const key = `${ev.repoConnectionId}:${ev.filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const repoName = naming.full(ev.repoConnectionId);
      lines.push(`| ${docCell(repoName)} | ${docCell(ev.filePath)} | ${docCell(ev.pattern)} |`);
      items.push({ repo: repoName, file: ev.filePath });
    }
  }

  if (items.length === 0) {
    return { markdown: "_No provenance data available._\n", items: [] };
  }

  return { markdown: lines.join("\n"), items };
}

function sanitizeMermaidId(id: string): string {
  return id.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 20);
}
