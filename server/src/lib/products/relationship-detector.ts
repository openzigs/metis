/**
 * Cross-repo relationship detector (Epic #544 / Issue #548).
 *
 * Scans crawled product repos and infers cross-repo relationships
 * (calls, imports, produces, consumes) with confidence scores.
 */
import type { ProductEdgeType, ProductEdgeEvidence } from "@metis/shared";
import type { CrawlResult, CrawlSpec, CrawlRoute, CrawlTypeDecl } from "./repo-crawler.js";

export interface DetectedEdge {
  sourceRepoId: string;
  targetRepoId: string;
  edgeType: ProductEdgeType;
  confidence: number;
  evidence: ProductEdgeEvidence[];
  sourceFile?: string;
  targetFile?: string;
}

export interface RepoCrawlData {
  repoConnectionId: string;
  crawlResult: CrawlResult;
  repoName: string;
  ownerOrOrg: string;
}

/**
 * Detect cross-repo relationships from crawled data of all repos in a product.
 */
export function detectRelationships(repos: RepoCrawlData[]): DetectedEdge[] {
  const edges: DetectedEdge[] = [];

  // Run all detection heuristics
  edges.push(...detectApiSpecReferences(repos));
  edges.push(...detectSharedTypes(repos));
  edges.push(...detectRouteConsumers(repos));
  edges.push(...detectProtobufPackages(repos));
  edges.push(...detectGraphQLReferences(repos));

  // Deduplicate edges with same source/target/type, keeping highest confidence
  return deduplicateEdges(edges);
}

/**
 * Detect when one repo's OpenAPI spec references another repo's service.
 * Confidence: 0.95 (explicit spec reference)
 */
function detectApiSpecReferences(repos: RepoCrawlData[]): DetectedEdge[] {
  const edges: DetectedEdge[] = [];
  const repoSpecs = new Map<string, { repo: RepoCrawlData; specs: CrawlSpec[] }>();

  for (const repo of repos) {
    const openApiSpecs = repo.crawlResult.specs.filter(
      (s) => s.format === "openapi" || s.format === "swagger",
    );
    if (openApiSpecs.length > 0) {
      repoSpecs.set(repo.repoConnectionId, { repo, specs: openApiSpecs });
    }
  }

  // Check if any repo's spec content references another repo's name or endpoints
  for (const [sourceId, { specs }] of repoSpecs) {
    for (const spec of specs) {
      for (const targetRepo of repos) {
        if (targetRepo.repoConnectionId === sourceId) continue;
        // Check if spec references the other repo by name
        const targetName = targetRepo.repoName.toLowerCase();
        const specLower = spec.content.toLowerCase();
        if (
          specLower.includes(targetName) ||
          specLower.includes(targetRepo.ownerOrOrg.toLowerCase() + "/" + targetName)
        ) {
          edges.push({
            sourceRepoId: sourceId,
            targetRepoId: targetRepo.repoConnectionId,
            edgeType: "calls",
            confidence: 0.95,
            evidence: [
              {
                filePath: spec.filePath,
                pattern: "openapi_spec_reference",
                snippet: `Spec references ${targetRepo.repoName}`,
                matchType: "spec_reference",
              },
            ],
            sourceFile: spec.filePath,
          });
        }
      }
    }
  }

  return edges;
}

/**
 * Detect shared type names across repos.
 * Confidence: 0.80 (same-named types exported in multiple repos)
 */
function detectSharedTypes(repos: RepoCrawlData[]): DetectedEdge[] {
  const edges: DetectedEdge[] = [];

  // Build a map of exported type names -> repos that export them
  const typeExports = new Map<string, Array<{ repoId: string; type: CrawlTypeDecl }>>();

  for (const repo of repos) {
    for (const typeDecl of repo.crawlResult.types) {
      if (!typeDecl.exported) continue;
      const existing = typeExports.get(typeDecl.name) ?? [];
      existing.push({ repoId: repo.repoConnectionId, type: typeDecl });
      typeExports.set(typeDecl.name, existing);
    }
  }

  // Types shared across repos suggest an imports/consumes relationship
  for (const [typeName, occurrences] of typeExports) {
    if (occurrences.length < 2) continue;

    // The repo with a "shared-lib" or "types" path is likely the source
    const sorted = [...occurrences].sort((a, b) => {
      const aIsShared =
        a.type.filePath.includes("shared") || a.type.filePath.includes("types") ? -1 : 0;
      const bIsShared =
        b.type.filePath.includes("shared") || b.type.filePath.includes("types") ? -1 : 0;
      return aIsShared - bIsShared;
    });

    const source = sorted[0];
    for (let i = 1; i < sorted.length; i++) {
      const target = sorted[i];
      edges.push({
        sourceRepoId: target.repoId,
        targetRepoId: source.repoId,
        edgeType: "imports",
        confidence: 0.8,
        evidence: [
          {
            filePath: target.type.filePath,
            lineNumber: target.type.lineNumber,
            pattern: "shared_type_name",
            snippet: `Both export type '${typeName}'`,
            matchType: "type_sharing",
          },
        ],
        sourceFile: target.type.filePath,
        targetFile: source.type.filePath,
      });
    }
  }

  return edges;
}

/**
 * Detect when one repo's routes are consumed by another repo's client code.
 * Confidence: 0.75 (URL pattern matching)
 */
function detectRouteConsumers(repos: RepoCrawlData[]): DetectedEdge[] {
  const edges: DetectedEdge[] = [];

  // Build map of repos with routes
  const repoRoutes = new Map<string, { repo: RepoCrawlData; routes: CrawlRoute[] }>();
  for (const repo of repos) {
    if (repo.crawlResult.routes.length > 0) {
      repoRoutes.set(repo.repoConnectionId, {
        repo,
        routes: repo.crawlResult.routes,
      });
    }
  }

  // Check if any repo's spec or content references route paths from another repo
  for (const [routeRepoId, { routes }] of repoRoutes) {
    for (const otherRepo of repos) {
      if (otherRepo.repoConnectionId === routeRepoId) continue;

      // Check if any spec in the other repo references these routes
      for (const spec of otherRepo.crawlResult.specs) {
        for (const route of routes) {
          // Normalize path for matching (remove param placeholders)
          const normalizedPath = route.path.replace(/:[^/]+|\{[^}]+\}/g, "");
          if (normalizedPath.length < 3) continue;

          if (spec.content.includes(normalizedPath)) {
            edges.push({
              sourceRepoId: otherRepo.repoConnectionId,
              targetRepoId: routeRepoId,
              edgeType: "calls",
              confidence: 0.75,
              evidence: [
                {
                  filePath: spec.filePath,
                  pattern: "route_path_reference",
                  snippet: `References route ${route.method} ${route.path}`,
                  matchType: "url_pattern",
                },
              ],
              sourceFile: spec.filePath,
              targetFile: route.filePath,
            });
            break; // One edge per spec-route combo
          }
        }
      }
    }
  }

  return edges;
}

/**
 * Detect shared protobuf package declarations across repos.
 * Confidence: 0.90 (same package name)
 */
function detectProtobufPackages(repos: RepoCrawlData[]): DetectedEdge[] {
  const edges: DetectedEdge[] = [];
  const packagePattern = /package\s+([\w.]+)\s*;/g;

  // Extract package names from proto specs
  const protoPackages = new Map<
    string,
    Array<{ repoId: string; filePath: string; packageName: string }>
  >();

  for (const repo of repos) {
    for (const spec of repo.crawlResult.specs) {
      if (spec.format !== "protobuf") continue;
      packagePattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = packagePattern.exec(spec.content)) !== null) {
        const pkg = match[1];
        const existing = protoPackages.get(pkg) ?? [];
        existing.push({
          repoId: repo.repoConnectionId,
          filePath: spec.filePath,
          packageName: pkg,
        });
        protoPackages.set(pkg, existing);
      }
    }
  }

  // Shared packages indicate a produces/consumes relationship
  for (const [pkgName, occurrences] of protoPackages) {
    if (occurrences.length < 2) continue;

    for (let i = 0; i < occurrences.length; i++) {
      for (let j = i + 1; j < occurrences.length; j++) {
        edges.push({
          sourceRepoId: occurrences[i].repoId,
          targetRepoId: occurrences[j].repoId,
          edgeType: "produces",
          confidence: 0.9,
          evidence: [
            {
              filePath: occurrences[i].filePath,
              pattern: "protobuf_package",
              snippet: `Shared protobuf package '${pkgName}'`,
              matchType: "proto_package",
            },
          ],
          sourceFile: occurrences[i].filePath,
          targetFile: occurrences[j].filePath,
        });
      }
    }
  }

  return edges;
}

/**
 * Detect GraphQL schema stitching / type extensions across repos.
 * Confidence: 0.85
 */
function detectGraphQLReferences(repos: RepoCrawlData[]): DetectedEdge[] {
  const edges: DetectedEdge[] = [];
  const typeExtendPattern = /extend\s+type\s+(\w+)/g;
  const typeDefPattern = /type\s+(\w+)\s*(?:@|\{)/g;

  // Map GraphQL type definitions to repos
  const typeDefs = new Map<string, Array<{ repoId: string; filePath: string }>>();
  const typeExtensions = new Map<string, Array<{ repoId: string; filePath: string }>>();

  for (const repo of repos) {
    for (const spec of repo.crawlResult.specs) {
      if (spec.format !== "graphql") continue;

      // Find type definitions
      typeDefPattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = typeDefPattern.exec(spec.content)) !== null) {
        const typeName = match[1];
        if (typeName === "Query" || typeName === "Mutation" || typeName === "Subscription")
          continue;
        const existing = typeDefs.get(typeName) ?? [];
        existing.push({ repoId: repo.repoConnectionId, filePath: spec.filePath });
        typeDefs.set(typeName, existing);
      }

      // Find type extensions
      typeExtendPattern.lastIndex = 0;
      while ((match = typeExtendPattern.exec(spec.content)) !== null) {
        const typeName = match[1];
        const existing = typeExtensions.get(typeName) ?? [];
        existing.push({ repoId: repo.repoConnectionId, filePath: spec.filePath });
        typeExtensions.set(typeName, existing);
      }
    }
  }

  // Extensions reference definitions
  for (const [typeName, extensions] of typeExtensions) {
    const defs = typeDefs.get(typeName) ?? [];
    for (const ext of extensions) {
      for (const def of defs) {
        if (ext.repoId === def.repoId) continue;
        edges.push({
          sourceRepoId: ext.repoId,
          targetRepoId: def.repoId,
          edgeType: "extends",
          confidence: 0.85,
          evidence: [
            {
              filePath: ext.filePath,
              pattern: "graphql_type_extension",
              snippet: `Extends GraphQL type '${typeName}'`,
              matchType: "graphql_extension",
            },
          ],
          sourceFile: ext.filePath,
          targetFile: def.filePath,
        });
      }
    }
  }

  return edges;
}

/**
 * Deduplicate edges, keeping the highest confidence for identical
 * source/target/type combinations.
 */
function deduplicateEdges(edges: DetectedEdge[]): DetectedEdge[] {
  const map = new Map<string, DetectedEdge>();
  for (const edge of edges) {
    const key = `${edge.sourceRepoId}:${edge.targetRepoId}:${edge.edgeType}`;
    const existing = map.get(key);
    if (!existing || edge.confidence > existing.confidence) {
      // Merge evidence from both
      if (existing) {
        edge.evidence = [...existing.evidence, ...edge.evidence];
      }
      map.set(key, edge);
    } else {
      // Append this edge's evidence to existing
      existing.evidence = [...existing.evidence, ...edge.evidence];
    }
  }
  return Array.from(map.values());
}
