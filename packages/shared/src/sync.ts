/**
 * Epic #739 — Bidirectional Issue Sync types.
 *
 * Shared between server and UI for type-safe drift detection,
 * reconciliation, and resolution workflows.
 */
import { z } from "zod";

// ---- Normalized webhook event (produced by both GitHub + Jira receivers) ---

export type IssueChangeSource = "github" | "jira";

export interface IssueChangeEvent {
  /** Unique id for dedup (delivery id for GitHub, event id for Jira). */
  deliveryId: string;
  source: IssueChangeSource;
  /** External issue key/id as stored in PublishedIssue.issueId. */
  externalId: string;
  /** External issue number (GitHub) or key (Jira). */
  externalRef: string;
  action: IssueChangeAction;
  /** Fields that changed. */
  changes: Partial<IssueChangeFields>;
  /** Full snapshot of external issue fields after the change. */
  current: IssueChangeFields;
  /** ISO timestamp of the event. */
  timestamp: string;
  /** Actor who made the change. */
  actor?: string;
}

export type IssueChangeAction =
  | "edited"
  | "closed"
  | "reopened"
  | "labeled"
  | "unlabeled"
  | "assigned"
  | "unassigned";

export interface IssueChangeFields {
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  assignees: string[];
}

// ---- Drift event (persisted row) -------------------------------------------

export type DriftStatus = "pending" | "resolved";
export type DriftResolutionAction = "adopt" | "push" | "divergent";

export interface DriftEventRow {
  id: string;
  publishedIssueId: string;
  projectId: string;
  requirementId: string | null;
  source: IssueChangeSource;
  deliveryId: string;
  action: IssueChangeAction;
  fieldDiffs: FieldDiff[];
  externalSnapshot: IssueChangeFields;
  localSnapshot: IssueChangeFields | null;
  status: DriftStatus;
  resolution: DriftResolutionAction | null;
  resolvedById: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

export interface FieldDiff {
  field: keyof IssueChangeFields;
  local: unknown;
  external: unknown;
}

// ---- API schemas -----------------------------------------------------------

export const resolveDriftSchema = z.object({
  action: z.enum(["adopt", "push", "divergent"]),
});

export type ResolveDriftInput = z.infer<typeof resolveDriftSchema>;

// ---- Socket event ----------------------------------------------------------

export interface DriftSocketEvent {
  projectId: string;
  driftEventId: string;
  publishedIssueId: string;
  requirementId: string | null;
  source: IssueChangeSource;
  fieldCount: number;
  ts: number;
}

// ---- Jira DC poll config ---------------------------------------------------

export const jiraPollConfigSchema = z.object({
  enabled: z.boolean(),
  pollIntervalSec: z.number().int().min(60).max(3600).default(300),
});

export type JiraPollConfig = z.infer<typeof jiraPollConfigSchema>;
