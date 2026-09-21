/**
 * Per-service doc generator with cross-references (Epic #544 / Issue #552).
 *
 * Generates per-repo documentation that includes cross-reference sections
 * showing how each service connects to its siblings within the same product.
 */
import type { ProductRepoInfo, ProductEdgeInfo, GeneratedDoc } from "./unified-doc-generator.js";

export interface PerServiceDocInput {
  productName: string;
  repo: ProductRepoInfo;
  allRepos: ProductRepoInfo[];
  edges: ProductEdgeInfo[];
}

/**
 * Generate a per-service documentation document with cross-references.
 */
export function generatePerServiceDoc(input: PerServiceDocInput): GeneratedDoc {
  const { productName, repo, allRepos, edges } = input;

  const repoMap = new Map<string, ProductRepoInfo>();
  for (const r of allRepos) {
    repoMap.set(r.repoConnectionId, r);
  }

  // Find edges where this repo is source or target
  const outgoingEdges = edges.filter((e) => e.sourceRepoId === repo.repoConnectionId);
  const incomingEdges = edges.filter((e) => e.targetRepoId === repo.repoConnectionId);

  const sections: string[] = [];

  // Title
  sections.push(`# ${repo.repoName} — Service Documentation\n`);

  // Overview
  sections.push("## Overview\n");
  sections.push(
    `${repo.repoName} is a service within the **${productName}** product, hosted at \`${repo.ownerOrOrg}/${repo.repoName}\`.\n`,
  );

  // Role
  if (repo.role) {
    sections.push(`## Role: ${repo.role}\n`);
    sections.push(`This service functions as a **${repo.role}** in the product architecture.\n`);
  }

  // Dependencies (outgoing)
  sections.push("## Dependencies\n");
  sections.push("### Services This Calls\n");
  if (outgoingEdges.length > 0) {
    for (const edge of outgoingEdges) {
      const target = repoMap.get(edge.targetRepoId);
      if (!target) continue;
      const evidenceSummary = edge.evidence.map((e) => e.snippet || e.pattern).join("; ");
      sections.push(
        `- **${target.repoName}** — ${edge.edgeType} (confidence: ${(edge.confidence * 100).toFixed(0)}%) — ${evidenceSummary}`,
      );
    }
  } else {
    sections.push("_No outgoing dependencies detected._");
  }
  sections.push("");

  // Dependents (incoming)
  sections.push("### Services That Call This\n");
  if (incomingEdges.length > 0) {
    for (const edge of incomingEdges) {
      const source = repoMap.get(edge.sourceRepoId);
      if (!source) continue;
      const evidenceSummary = edge.evidence.map((e) => e.snippet || e.pattern).join("; ");
      sections.push(
        `- **${source.repoName}** — ${edge.edgeType} (confidence: ${(edge.confidence * 100).toFixed(0)}%) — ${evidenceSummary}`,
      );
    }
  } else {
    sections.push("_No incoming dependencies detected._");
  }
  sections.push("");

  // Cross-References table
  sections.push("## Cross-References\n");
  const allRelated = [...outgoingEdges, ...incomingEdges];
  if (allRelated.length > 0) {
    sections.push("| Related Service | Relationship | Direction | Confidence | Evidence |");
    sections.push("|----------------|-------------|-----------|-----------|----------|");
    for (const edge of outgoingEdges) {
      const target = repoMap.get(edge.targetRepoId);
      const evidenceSummary = edge.evidence[0]?.filePath ?? "";
      sections.push(
        `| ${target?.repoName ?? "unknown"} | ${edge.edgeType} | outgoing | ${(edge.confidence * 100).toFixed(0)}% | ${evidenceSummary} |`,
      );
    }
    for (const edge of incomingEdges) {
      const source = repoMap.get(edge.sourceRepoId);
      const evidenceSummary = edge.evidence[0]?.filePath ?? "";
      sections.push(
        `| ${source?.repoName ?? "unknown"} | ${edge.edgeType} | incoming | ${(edge.confidence * 100).toFixed(0)}% | ${evidenceSummary} |`,
      );
    }
  } else {
    sections.push("_No cross-repo relationships detected for this service._");
  }
  sections.push("");

  const content = sections.join("\n");
  const provenance = allRelated.flatMap((e) =>
    e.evidence.map((ev) => ({
      repo: `${repo.ownerOrOrg}/${repo.repoName}`,
      file: ev.filePath,
    })),
  );

  return {
    title: `${repo.repoName} — Service Documentation`,
    content,
    metadata: {
      generatedAt: new Date().toISOString(),
      repoCount: 1,
      edgeCount: allRelated.length,
      provenance,
    },
  };
}

/**
 * Generate per-service docs for all repos in a product.
 */
export function generateAllPerServiceDocs(input: {
  productName: string;
  repos: ProductRepoInfo[];
  edges: ProductEdgeInfo[];
}): GeneratedDoc[] {
  return input.repos.map((repo) =>
    generatePerServiceDoc({
      productName: input.productName,
      repo,
      allRepos: input.repos,
      edges: input.edges,
    }),
  );
}
