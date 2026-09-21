/**
 * Semantic API-contract diff engine (Issue #90 / Epic #86).
 *
 * The product API-contract doc is regenerated on every product analysis run.
 * To version it meaningfully we compare the *structured* contract — the set of
 * endpoints (OpenAPI/Swagger), types (GraphQL) and services/messages (protobuf)
 * — rather than doing a raw text diff of the rendered Markdown. This keeps the
 * diff stable against cosmetic rendering changes and lets us report
 * added / removed / changed at the granularity of a single endpoint or type.
 *
 * The same normalised item set feeds a stable content hash used by the
 * persistence layer to dedupe: regenerating an unchanged spec produces the same
 * hash and therefore does NOT create a spurious new version.
 */
import { createHash } from "node:crypto";
import type { CrawlSpec } from "./repo-crawler.js";
import {
  parseOpenApiEndpoints,
  parseGraphQLTypes,
  parseProtobuf,
} from "./api-contract-doc-generator.js";

/** One comparable unit of an API contract. */
export interface ContractItem {
  /** Contract family this item belongs to. */
  format: "openapi" | "graphql" | "protobuf";
  /** endpoint | type | service | message */
  kind: "endpoint" | "type" | "service" | "message";
  /**
   * Stable, human-readable identity used to match items across versions
   * (e.g. `openapi endpoint GET /users`, `graphql type User`).
   */
  id: string;
  /**
   * Order-independent structural signature. When the `id` matches across
   * versions but the signature differs, the item is reported as "changed".
   */
  signature: string;
}

export interface ChangedItem {
  id: string;
  format: ContractItem["format"];
  kind: ContractItem["kind"];
  before: string;
  after: string;
}

export interface ContractDiff {
  added: ContractItem[];
  removed: ContractItem[];
  changed: ChangedItem[];
  hasChanges: boolean;
}

/** Normalise a signature fragment so cosmetic ordering never triggers a diff. */
function sortedJoin(parts: string[]): string {
  return [...parts].sort((a, b) => a.localeCompare(b)).join(", ");
}

/**
 * Flatten a list of specs into a sorted, order-independent set of comparable
 * contract items. Swagger is folded into the `openapi` family.
 */
export function extractContractItems(specs: CrawlSpec[]): ContractItem[] {
  const items: ContractItem[] = [];

  for (const spec of specs) {
    switch (spec.format) {
      case "openapi":
      case "swagger": {
        for (const ep of parseOpenApiEndpoints(spec.content)) {
          const params = sortedJoin(
            (ep.parameters ?? []).map(
              (p) => `${p.name}:${p.in}:${p.required ? "req" : "opt"}:${p.type ?? "string"}`,
            ),
          );
          const responses = sortedJoin((ep.responses ?? []).map((r) => r.status));
          items.push({
            format: "openapi",
            kind: "endpoint",
            id: `openapi endpoint ${ep.method} ${ep.path}`,
            signature: `summary=${ep.summary ?? ""}|params=[${params}]|responses=[${responses}]`,
          });
        }
        break;
      }
      case "graphql": {
        for (const t of parseGraphQLTypes(spec.content)) {
          const fields = sortedJoin((t.fields ?? []).map((f) => `${f.name}:${f.type}`));
          items.push({
            format: "graphql",
            kind: "type",
            id: `graphql ${t.kind === "type" ? "type" : t.kind} ${t.name}`,
            signature: `kind=${t.kind}|fields=[${fields}]`,
          });
        }
        break;
      }
      case "protobuf": {
        const { services, messages } = parseProtobuf(spec.content);
        for (const svc of services) {
          const methods = sortedJoin(
            svc.methods.map((m) => `${m.name}(${m.inputType})->${m.outputType}`),
          );
          items.push({
            format: "protobuf",
            kind: "service",
            id: `protobuf service ${svc.name}`,
            signature: `methods=[${methods}]`,
          });
        }
        for (const msg of messages) {
          const fields = sortedJoin(msg.fields.map((f) => `${f.name}:${f.type}=${f.number}`));
          items.push({
            format: "protobuf",
            kind: "message",
            id: `protobuf message ${msg.name}`,
            signature: `fields=[${fields}]`,
          });
        }
        break;
      }
    }
  }

  // De-dupe by id (last wins) then sort for determinism.
  const byId = new Map<string, ContractItem>();
  for (const item of items) byId.set(item.id, item);
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Stable SHA-256 over the normalised item set. Identical contracts (regardless
 * of spec ordering or cosmetic rendering) produce identical hashes — the basis
 * for version dedupe.
 */
export function hashContractItems(items: ContractItem[]): string {
  const canonical = [...items]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((i) => `${i.id}\u0000${i.signature}`)
    .join("");
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Compute a semantic diff of two contract-item sets. `previous` may be empty
 * (first meaningful version), in which case every current item is "added".
 */
export function diffContracts(previous: ContractItem[], next: ContractItem[]): ContractDiff {
  const prevById = new Map(previous.map((i) => [i.id, i]));
  const nextById = new Map(next.map((i) => [i.id, i]));

  const added: ContractItem[] = [];
  const removed: ContractItem[] = [];
  const changed: ChangedItem[] = [];

  for (const item of next) {
    const prior = prevById.get(item.id);
    if (!prior) {
      added.push(item);
    } else if (prior.signature !== item.signature) {
      changed.push({
        id: item.id,
        format: item.format,
        kind: item.kind,
        before: prior.signature,
        after: item.signature,
      });
    }
  }

  for (const item of previous) {
    if (!nextById.has(item.id)) removed.push(item);
  }

  const sortById = <T extends { id: string }>(arr: T[]): T[] =>
    arr.sort((a, b) => a.id.localeCompare(b.id));

  sortById(added);
  sortById(removed);
  sortById(changed);

  return {
    added,
    removed,
    changed,
    hasChanges: added.length > 0 || removed.length > 0 || changed.length > 0,
  };
}

/** Strip the `<format> <kind> ` prefix so the label reads as the bare identity. */
function label(id: string): string {
  const parts = id.split(" ");
  return parts.slice(2).join(" ") || id;
}

/** Compact one-line human summary — also stored as the version diffSummary. */
export function summarizeDiff(diff: ContractDiff): string {
  if (!diff.hasChanges) return "No contract changes since the previous version.";
  return `${diff.added.length} added, ${diff.removed.length} removed, ${diff.changed.length} changed.`;
}

/**
 * Render the diff as a Markdown section appended to the generated contract doc.
 * Passing `null` (no previous version) renders the "initial version" notice.
 */
export function renderContractDiff(diff: ContractDiff | null): string {
  const lines: string[] = ["## Changes Since Previous Version\n"];

  if (diff === null) {
    lines.push("_Initial version — no previous contract to compare against._\n");
    return lines.join("\n");
  }

  if (!diff.hasChanges) {
    lines.push("_No contract changes since the previous version._\n");
    return lines.join("\n");
  }

  lines.push(`**Summary:** ${summarizeDiff(diff)}\n`);

  if (diff.added.length > 0) {
    lines.push("### Added\n");
    for (const item of diff.added)
      lines.push(`- \`${label(item.id)}\` (${item.format} ${item.kind})`);
    lines.push("");
  }

  if (diff.removed.length > 0) {
    lines.push("### Removed\n");
    for (const item of diff.removed)
      lines.push(`- \`${label(item.id)}\` (${item.format} ${item.kind})`);
    lines.push("");
  }

  if (diff.changed.length > 0) {
    lines.push("### Changed\n");
    for (const item of diff.changed)
      lines.push(`- \`${label(item.id)}\` (${item.format} ${item.kind})`);
    lines.push("");
  }

  return lines.join("\n");
}
