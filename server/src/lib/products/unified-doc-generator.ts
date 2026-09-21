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

export interface UnifiedDocInput {
  productName: string;
  productDescription: string;
  repos: ProductRepoInfo[];
  edges: ProductEdgeInfo[];
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

  const repoMap = new Map<string, ProductRepoInfo>();
  for (const repo of repos) {
    repoMap.set(repo.repoConnectionId, repo);
  }

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
  sections.push(generateServiceMapDiagram(repos, edges, repoMap));
  sections.push("");

  // API Contracts
  sections.push("## API Contracts\n");
  sections.push(generateApiContractsSection(edges, repoMap));
  sections.push("");

  // Data Flow
  sections.push("## Data Flow\n");
  sections.push(generateDataFlowDiagram(repos, edges, repoMap));
  sections.push("");

  // Cross-Cutting Concerns
  sections.push("## Cross-Cutting Concerns\n");
  sections.push(generateCrossCuttingSection(repos, repoMap));
  sections.push("");

  // Provenance
  sections.push("## Provenance\n");
  const provenance = generateProvenance(edges, repoMap);
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
  _repoMap: Map<string, ProductRepoInfo>,
): string {
  const lines: string[] = ["```mermaid", "graph TB"];

  // Add nodes
  for (const repo of repos) {
    const label = repo.role ? `${repo.repoName}\\n[${repo.role}]` : repo.repoName;
    const id = sanitizeMermaidId(repo.repoConnectionId);
    lines.push(`    ${id}["${label}"]`);
  }

  // Add edges
  for (const edge of edges) {
    const sourceId = sanitizeMermaidId(edge.sourceRepoId);
    const targetId = sanitizeMermaidId(edge.targetRepoId);
    const label = `${edge.edgeType} (${(edge.confidence * 100).toFixed(0)}%)`;
    lines.push(`    ${sourceId} -->|"${label}"| ${targetId}`);
  }

  lines.push("```");
  return lines.join("\n");
}

function generateDataFlowDiagram(
  _repos: ProductRepoInfo[],
  edges: ProductEdgeInfo[],
  repoMap: Map<string, ProductRepoInfo>,
): string {
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
    const repo = repoMap.get(pid);
    if (repo) {
      lines.push(`    participant ${sanitizeMermaidId(pid)} as ${repo.repoName}`);
    }
  }

  // Add interactions
  for (const edge of dataEdges) {
    const src = sanitizeMermaidId(edge.sourceRepoId);
    const tgt = sanitizeMermaidId(edge.targetRepoId);
    const arrow = edge.edgeType === "calls" ? "->>" : "-->>";
    lines.push(`    ${src}${arrow}${tgt}: ${edge.edgeType}`);
  }

  lines.push("```");
  return lines.join("\n");
}

function generateApiContractsSection(
  edges: ProductEdgeInfo[],
  repoMap: Map<string, ProductRepoInfo>,
): string {
  const callEdges = edges.filter((e) => e.edgeType === "calls");

  if (callEdges.length === 0) {
    return "_No API contract edges detected._\n";
  }

  const lines: string[] = [
    "| Source | Target | Confidence | Evidence |",
    "|--------|--------|-----------|----------|",
  ];

  for (const edge of callEdges) {
    const source = repoMap.get(edge.sourceRepoId);
    const target = repoMap.get(edge.targetRepoId);
    const evidenceSummary = edge.evidence.map((e) => e.snippet || e.pattern).join("; ");
    lines.push(
      `| ${source?.repoName ?? "unknown"} | ${target?.repoName ?? "unknown"} | ${(edge.confidence * 100).toFixed(0)}% | ${evidenceSummary} |`,
    );
  }

  return lines.join("\n");
}

function generateCrossCuttingSection(
  repos: ProductRepoInfo[],
  _repoMap: Map<string, ProductRepoInfo>,
): string {
  const lines: string[] = ["| Service | Role | Repository |", "|---------|------|------------|"];

  for (const repo of repos) {
    lines.push(
      `| ${repo.repoName} | ${repo.role ?? "unspecified"} | ${repo.ownerOrOrg}/${repo.repoName} |`,
    );
  }

  return lines.join("\n");
}

function generateProvenance(
  edges: ProductEdgeInfo[],
  repoMap: Map<string, ProductRepoInfo>,
): { markdown: string; items: Array<{ repo: string; file?: string; commitSha?: string }> } {
  const items: Array<{ repo: string; file?: string; commitSha?: string }> = [];
  const lines: string[] = ["| Repo | File | Evidence |", "|------|------|----------|"];

  const seen = new Set<string>();
  for (const edge of edges) {
    for (const ev of edge.evidence) {
      const sourceRepo = repoMap.get(edge.sourceRepoId);
      const key = `${sourceRepo?.repoName}:${ev.filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const repoName = sourceRepo ? `${sourceRepo.ownerOrOrg}/${sourceRepo.repoName}` : "unknown";
      lines.push(`| ${repoName} | ${ev.filePath} | ${ev.pattern} |`);
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
