/**
 * ProductContractDoc versioning + diff orchestration (Issue #90 / Epic #86).
 *
 * On every product analysis run the API-contract doc for a repo is regenerated.
 * This module:
 *   1. extracts the structured contract items from the specs;
 *   2. computes a stable `contentHash` over them;
 *   3. loads the previous version for `(productId, repoId)`;
 *   4. DEDUPES — if the hash is unchanged, returns the existing version WITHOUT
 *      creating a new row (regenerating an unchanged spec must not bump);
 *   5. otherwise appends a new monotonic version, computes the semantic diff vs
 *      the previous version, and appends a rendered diff section to the doc.
 *
 * Persistence is injected as `ContractDocStore` so the logic is pure and unit
 * testable; the route wires in a Prisma-backed implementation.
 */
import type { CrawlSpec } from "./repo-crawler.js";
import { generateApiContractDoc } from "./api-contract-doc-generator.js";
import type { GeneratedDoc } from "./unified-doc-generator.js";
import {
  extractContractItems,
  hashContractItems,
  diffContracts,
  renderContractDiff,
  summarizeDiff,
  type ContractDiff,
  type ContractItem,
} from "./contract-diff.js";

/** A persisted contract-doc version row (provider-agnostic shape). */
export interface ContractDocVersionRecord {
  productId: string;
  /** RepoConnection id this contract belongs to (never null in practice, but
   *  typed nullable to mirror ProductDocument.repoId). */
  repoId: string | null;
  version: number;
  /** SHA-256 of the normalised contract item set — the dedupe key. */
  contentHash: string;
  /** JSON: `{ file, format }[]` identifying the source specs. */
  specIdentity: string;
  /**
   * JSON: the normalised `ContractItem[]` for THIS version. Persisted so the
   * next run diffs against the exact structured contract instead of re-parsing
   * specs we no longer retain.
   */
  itemsSnapshot: string;
  /** JSON: the full ContractDiff vs the previous version (null for v1). */
  diff: string | null;
  /** One-line human summary of the diff. */
  diffSummary: string;
  /** Rendered Markdown content (includes the diff section). */
  content: string;
  title: string;
  generatedAt: string;
}

/** Minimal persistence seam — implemented over Prisma by the route. */
export interface ContractDocStore {
  findLatest(productId: string, repoId: string | null): Promise<ContractDocVersionRecord | null>;
  create(record: ContractDocVersionRecord): Promise<ContractDocVersionRecord>;
}

/** A persisted DB row as returned by Prisma (`generatedAt` is a Date, plus the
 *  `id`/`createdAt` columns the domain record does not carry). */
interface ContractDocDbRow {
  productId: string;
  repoId: string | null;
  version: number;
  contentHash: string;
  specIdentity: string;
  itemsSnapshot: string;
  diff: string | null;
  diffSummary: string;
  content: string;
  title: string;
  generatedAt: Date;
}

/** Minimal Prisma delegate shape needed to back the store (keeps this module
 *  decoupled from the generated client type so it is trivially mockable). */
export interface ProductContractDocDelegate {
  findFirst(args: {
    where: { productId: string; repoId: string | null };
    orderBy: { version: "desc" };
  }): Promise<ContractDocDbRow | null>;
  create(args: {
    data: Omit<ContractDocVersionRecord, "generatedAt"> & { generatedAt: Date };
  }): Promise<ContractDocDbRow>;
}

function toRecord(row: ContractDocDbRow): ContractDocVersionRecord {
  return {
    productId: row.productId,
    repoId: row.repoId,
    version: row.version,
    contentHash: row.contentHash,
    specIdentity: row.specIdentity,
    itemsSnapshot: row.itemsSnapshot,
    diff: row.diff,
    diffSummary: row.diffSummary,
    content: row.content,
    title: row.title,
    generatedAt: row.generatedAt.toISOString(),
  };
}

/**
 * Build a `ContractDocStore` backed by a Prisma `productContractDoc` delegate.
 * The record shape maps 1:1 onto the `product_contract_docs` columns, with
 * `generatedAt` marshalled between the domain (ISO string) and the DB (Date).
 */
export function createPrismaContractDocStore(
  delegate: ProductContractDocDelegate,
): ContractDocStore {
  return {
    findLatest: async (productId, repoId) => {
      const row = await delegate.findFirst({
        where: { productId, repoId },
        orderBy: { version: "desc" },
      });
      return row ? toRecord(row) : null;
    },
    create: async (record) => {
      const row = await delegate.create({
        data: { ...record, generatedAt: new Date(record.generatedAt) },
      });
      return toRecord(row);
    },
  };
}

export interface RecordContractDocInput {
  productId: string;
  productName: string;
  repoName: string;
  repoConnectionId: string;
  ownerOrOrg: string;
  specs: CrawlSpec[];
}

export interface RecordContractDocResult {
  version: number;
  /** true when a new version row was written; false on a dedupe hit. */
  created: boolean;
  contentHash: string;
  /** Structural diff vs the previous version (null for the initial version). */
  diff: ContractDiff | null;
  /** The rendered doc (base contract doc + diff section). */
  doc: GeneratedDoc;
}

/** Compact JSON identity of the source specs (order-independent). */
function specIdentity(specs: CrawlSpec[]): string {
  const ids = specs
    .map((s) => ({ file: s.filePath, format: s.format }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return JSON.stringify(ids);
}

/**
 * Generate, version and diff a product API-contract doc for a single repo.
 * Idempotent per contentHash: unchanged specs return the existing version.
 */
export async function recordContractDocVersion(
  input: RecordContractDocInput,
  store: ContractDocStore,
): Promise<RecordContractDocResult> {
  const { productId, repoConnectionId } = input;
  const repoId = repoConnectionId;

  const items: ContractItem[] = extractContractItems(input.specs);
  const contentHash = hashContractItems(items);

  const previous = await store.findLatest(productId, repoId);

  // Dedupe: identical structured contract → no new version.
  if (previous && previous.contentHash === contentHash) {
    const previousDiff = previous.diff ? (JSON.parse(previous.diff) as ContractDiff) : null;
    return {
      version: previous.version,
      created: false,
      contentHash,
      diff: previousDiff,
      doc: {
        title: previous.title,
        content: previous.content,
        metadata: {
          generatedAt: previous.generatedAt,
          repoCount: 1,
          edgeCount: 0,
          provenance: input.specs.map((s) => ({
            repo: `${input.ownerOrOrg}/${input.repoName}`,
            file: s.filePath,
          })),
        },
      },
    };
  }

  const version = previous ? previous.version + 1 : 1;
  const isInitial = previous === null;

  // Compute the semantic diff against the previous version's stored contract.
  let diff: ContractDiff | null = null;
  if (!isInitial) {
    const prevItems = reconstructPreviousItems(previous);
    diff = diffContracts(prevItems, items);
  }

  const base = generateApiContractDoc(input);
  const diffSection = renderContractDiff(diff);
  const content = `${base.content}\n${diffSection}`;
  const generatedAt = new Date().toISOString();
  const diffSummary = diff ? summarizeDiff(diff) : "Initial version.";

  const doc: GeneratedDoc = {
    title: base.title,
    content,
    metadata: { ...base.metadata, generatedAt },
  };

  await store.create({
    productId,
    repoId,
    version,
    contentHash,
    specIdentity: specIdentity(input.specs),
    itemsSnapshot: JSON.stringify(items),
    diff: diff ? JSON.stringify(diff) : null,
    diffSummary,
    content,
    title: base.title,
    generatedAt,
  });

  return { version, created: true, contentHash, diff, doc };
}

/**
 * Recover the previous version's contract items from its persisted snapshot so
 * the next diff compares against the exact structured contract, not a re-parse
 * of specs we no longer retain. Falls back to an empty set (treats everything
 * as added) if the snapshot is missing or malformed.
 */
function reconstructPreviousItems(previous: ContractDocVersionRecord): ContractItem[] {
  if (!previous.itemsSnapshot) return [];
  try {
    const parsed = JSON.parse(previous.itemsSnapshot) as ContractItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
