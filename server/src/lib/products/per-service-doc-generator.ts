/**
 * Per-service doc generator with cross-references (Epic #544 / Issue #552).
 *
 * Generates per-repo documentation that includes cross-reference sections
 * showing how each service connects to its siblings within the same product.
 */
import {
  docCell,
  repoNaming,
  visibleEvidence,
  type ExternalRepoInfo,
  type GeneratedDoc,
  type ProductEdgeInfo,
  type ProductRepoInfo,
} from "./unified-doc-generator.js";

export interface PerServiceDocInput {
  productName: string;
  repo: ProductRepoInfo;
  allRepos: ProductRepoInfo[];
  edges: ProductEdgeInfo[];
  /** #1732 — the far ends of cross-product edges, named by their label. */
  externalRepos?: ExternalRepoInfo[];
}

/**
 * Generate a per-service documentation document with cross-references.
 */
export function generatePerServiceDoc(input: PerServiceDocInput): GeneratedDoc {
  const { productName, repo, allRepos, edges } = input;
  const naming = repoNaming(allRepos, input.externalRepos);
  const summary = (edge: ProductEdgeInfo) =>
    docCell(
      visibleEvidence(edge, naming)
        .map((e) => e.snippet || e.pattern)
        .join("; "),
    );

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
      sections.push(
        `- **${docCell(naming.name(edge.targetRepoId))}** — ${edge.edgeType} (confidence: ${(edge.confidence * 100).toFixed(0)}%) — ${summary(edge)}`,
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
      sections.push(
        `- **${docCell(naming.name(edge.sourceRepoId))}** — ${edge.edgeType} (confidence: ${(edge.confidence * 100).toFixed(0)}%) — ${summary(edge)}`,
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
    const firstFile = (edge: ProductEdgeInfo) =>
      docCell(visibleEvidence(edge, naming)[0]?.filePath ?? "");
    for (const edge of outgoingEdges) {
      sections.push(
        `| ${docCell(naming.name(edge.targetRepoId))} | ${edge.edgeType} | outgoing | ${(edge.confidence * 100).toFixed(0)}% | ${firstFile(edge)} |`,
      );
    }
    for (const edge of incomingEdges) {
      sections.push(
        `| ${docCell(naming.name(edge.sourceRepoId))} | ${edge.edgeType} | incoming | ${(edge.confidence * 100).toFixed(0)}% | ${firstFile(edge)} |`,
      );
    }
  } else {
    sections.push("_No cross-repo relationships detected for this service._");
  }
  sections.push("");

  const content = sections.join("\n");
  // #1732 (#1727) — each file credited to the repo it is in, not to this one.
  const provenance = allRelated.flatMap((e) =>
    visibleEvidence(e, naming).map((ev) => ({
      repo: naming.full(ev.repoConnectionId),
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
  externalRepos?: ExternalRepoInfo[];
}): GeneratedDoc[] {
  return input.repos.map((repo) =>
    generatePerServiceDoc({
      productName: input.productName,
      repo,
      allRepos: input.repos,
      edges: input.edges,
      externalRepos: input.externalRepos,
    }),
  );
}
