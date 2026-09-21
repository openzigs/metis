/**
 * Jira test-case provider (Epic #856, issue #873).
 *
 * Imports test cases stored as Jira issues (typically issuetype = "Test")
 * by reusing the existing `JiraClient` from Epic #556. Field mapping is
 * configurable so customers can point at custom fields for steps, expected
 * results, and preconditions.
 *
 * Pagination is delegated to `client.searchIssuesAll` (cursor-based with
 * `startAt`). The provider is fully decoupled from the database — callers
 * pass in an already-built `JiraClient` (see
 * `connectors/jira/jira-service.ts#buildJiraClientForConnection`).
 */
import type { JiraIssue, NormalisedTestCase } from "@metis/shared";

import type { JiraClient } from "../../connectors/jira/jira-client.js";
import { finaliseCase, normalisePriority, normaliseTags } from "../normaliser.js";

export interface JiraFieldMapping {
  /** Field containing the test title. Defaults to `summary`. */
  readonly titleField?: string;
  /** Field containing preconditions. Defaults to `description`. */
  readonly preconditionsField?: string;
  /** Field containing concatenated steps (newline-delimited). */
  readonly stepsField?: string;
  /** Field containing concatenated expected results (newline-delimited, parallel to steps). */
  readonly expectedField?: string;
  /** Field containing priority. Defaults to `priority`. */
  readonly priorityField?: string;
  /** Field containing labels/tags. Defaults to `labels`. */
  readonly tagsField?: string;
}

export interface JiraImportOptions {
  readonly projectKey: string;
  /** Issue types to include. Defaults to `["Test", "Test Case"]`. */
  readonly issueTypes?: ReadonlyArray<string>;
  /** Additional JQL clause AND-ed to the auto-generated query. */
  readonly extraJql?: string;
  readonly fieldMapping?: JiraFieldMapping;
  readonly pageSize?: number;
}

export interface JiraImportSummary {
  readonly cases: ReadonlyArray<NormalisedTestCase>;
  readonly fetched: number;
}

const DEFAULT_ISSUE_TYPES = ["Test", "Test Case"] as const;

export async function importJiraTestCases(
  client: JiraClient,
  options: JiraImportOptions,
): Promise<JiraImportSummary> {
  const mapping: Required<JiraFieldMapping> = {
    titleField: options.fieldMapping?.titleField ?? "summary",
    preconditionsField: options.fieldMapping?.preconditionsField ?? "description",
    stepsField: options.fieldMapping?.stepsField ?? "steps",
    expectedField: options.fieldMapping?.expectedField ?? "expected",
    priorityField: options.fieldMapping?.priorityField ?? "priority",
    tagsField: options.fieldMapping?.tagsField ?? "labels",
  };

  const jql = buildJql(options);
  const fields = uniqueNonEmpty([
    mapping.titleField,
    mapping.preconditionsField,
    mapping.stepsField,
    mapping.expectedField,
    mapping.priorityField,
    mapping.tagsField,
    "issuetype",
  ]);

  const cases: NormalisedTestCase[] = [];
  let fetched = 0;
  const iterator = client.searchIssuesAll(jql, {
    maxResults: options.pageSize ?? 50,
    fields,
  });

  for await (const issue of iterator) {
    fetched += 1;
    const mapped = mapIssue(issue, mapping);
    if (mapped) cases.push(mapped);
  }
  return { cases, fetched };
}

function buildJql(options: JiraImportOptions): string {
  const issueTypes = (
    options.issueTypes && options.issueTypes.length > 0 ? options.issueTypes : DEFAULT_ISSUE_TYPES
  )
    .map((t) => `"${escapeJql(t)}"`)
    .join(", ");
  const clauses = [`project = "${escapeJql(options.projectKey)}"`, `issuetype in (${issueTypes})`];
  if (options.extraJql) clauses.push(`(${options.extraJql})`);
  return clauses.join(" AND ");
}

function escapeJql(value: string): string {
  return value.replace(/"/g, '\\"');
}

function uniqueNonEmpty(values: string[]): string[] {
  return [...new Set(values.filter((v) => v && v.length > 0))];
}

function mapIssue(issue: JiraIssue, m: Required<JiraFieldMapping>): NormalisedTestCase | null {
  const fields = (issue.fields ?? {}) as Record<string, unknown>;
  const title = toStringValue(fields[m.titleField]) ?? "";
  const preconditions = toStringValue(fields[m.preconditionsField]) ?? undefined;
  const stepsRaw = toStringValue(fields[m.stepsField]) ?? "";
  const expectedRaw = toStringValue(fields[m.expectedField]) ?? "";
  const priority = readPriority(fields[m.priorityField]);
  const tags = readTags(fields[m.tagsField]);

  const stepLines = stepsRaw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const expectedLines = expectedRaw.split(/\r?\n/).map((s) => s.trim());

  const steps = stepLines.map((action, idx) => ({
    action,
    expected: expectedLines[idx] && expectedLines[idx].length > 0 ? expectedLines[idx] : undefined,
  }));

  return finaliseCase(
    {
      externalId: issue.key,
      title,
      preconditions,
      steps,
      expected: stepLines.length === 0 ? expectedRaw.trim() || undefined : undefined,
      priority: normalisePriority(priority),
      tags: normaliseTags(tags.join(",")),
    },
    "jira",
  );
}

function toStringValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "object") {
    const v = value as Record<string, unknown>;
    // Atlassian doc format / rich text fields → grab `content[].content[].text`.
    if (typeof v.content === "object" && Array.isArray((v as { content?: unknown[] }).content)) {
      return flattenAdf(v);
    }
    if (typeof v.value === "string") return v.value;
    if (typeof v.name === "string") return v.name;
  }
  return null;
}

function flattenAdf(node: Record<string, unknown>): string {
  const out: string[] = [];
  const stack: unknown[] = [node];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    const c = cur as Record<string, unknown>;
    if (typeof c.text === "string") out.push(c.text);
    if (Array.isArray(c.content)) {
      for (let i = c.content.length - 1; i >= 0; i -= 1) stack.push(c.content[i]);
    }
  }
  return out.join("\n");
}

function readPriority(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (typeof value === "object" && "name" in (value as object)) {
    const v = (value as { name?: unknown }).name;
    if (typeof v === "string") return v;
  }
  return null;
}

function readTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === "string" ? v : String(v))).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}
