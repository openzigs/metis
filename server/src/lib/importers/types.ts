/**
 * Inbound importer framework — Epic #776, issue #777.
 *
 * Defines the common contract every tracker importer (GitHub / Jira /
 * Azure DevOps / Linear) implements so the import service can drive preview,
 * fetch, map and dedup uniformly.
 */
import type { ImportSourceKind } from "@metis/shared";

/** A raw issue/work-item fetched from an external tracker. */
export interface ExternalIssue {
  /** Stable id within the source (GitHub issue number, Jira key, …). */
  externalId: string;
  externalSource: ImportSourceKind;
  /** Canonical URL back to the source item. */
  url: string;
  title: string;
  body: string;
  /** Raw upstream state (open/closed/Done/…), source-specific. */
  state?: string;
  /** Source labels/tags. */
  labels: string[];
  /** Raw type hint from the source (issuetype name, work item type, …). */
  type?: string;
  /** Raw priority hint from the source. */
  priority?: string;
  /** Parent external id for hierarchy links (Azure DevOps parent/child). */
  parentExternalId?: string | null;
  /** Original payload, retained for debugging / custom field mapping. */
  raw?: unknown;
}

/** A normalised requirement shape ready to upsert. */
export interface MappedRequirement {
  externalId: string;
  externalSource: ImportSourceKind;
  externalUrl: string;
  title: string;
  body: string;
  /** feature|bug|chore|epic|task */
  type: string;
  /** low|medium|high|critical */
  priority: string;
  labels: string[];
  parentExternalId?: string | null;
}

export interface ImporterFetchContext {
  signal?: AbortSignal;
  onProgress?(info: { fetched: number; page?: number }): void;
}

/** SSRF guard injected into importers (defaults to the connector allowlist). */
export type AssertHostAllowed = (hostname: string) => void | Promise<void>;

/** Injectable `fetch` so importers stay unit-testable without network. */
export type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** Tunable backoff knobs threaded to fetchWithBackoff (injectable in tests). */
export interface BackoffTuning {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/**
 * Common importer contract. `count` powers preview (cheap), `fetchAll` streams
 * every item (paginated, with backoff) and `map` normalises a single item.
 */
export interface Importer<F = unknown> {
  readonly kind: ImportSourceKind;
  /** Cheap total count used by preview. */
  count(filter: F, ctx?: ImporterFetchContext): Promise<number>;
  /** Stream all external issues, handling pagination + rate limits. */
  fetchAll(filter: F, ctx?: ImporterFetchContext): AsyncGenerator<ExternalIssue>;
  /** Normalise an external issue into a requirement shape. */
  map(issue: ExternalIssue): MappedRequirement;
}
