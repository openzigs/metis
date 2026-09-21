"use client";

/**
 * Issue #827 (Epic #820) — per-requirement DATABASE CHANGES section of the gap
 * report.
 *
 * The database twin of the gap findings: the affected tables/columns for a
 * requirement (assembled server-side in #825), each with its suggested DDL,
 * live-schema reconciliation, risk classification, and cross-project
 * (shared-database) consumers.
 *
 * SAFETY (carried verbatim from #825 — do NOT regress):
 *   - `suggestedDdl` is TEXT ONLY and is NEVER executed. It is rendered inert
 *     inside a <pre> (never `dangerouslySetInnerHTML`) behind a persistent,
 *     always-visible "review only, never executed" label — not a tooltip.
 *   - Rows the impact engine could not reconcile against the live schema
 *     (`table-not-found` / `column-not-found`) are split into their own
 *     "unverified" table with a could-not-verify treatment, so an unproven
 *     claim can never read as a confirmed change.
 *   - A row whose cross-project identity could not be resolved
 *     (`identityResolved: false`) renders "cross-project impact unknown", NEVER
 *     "no consumers". Only a resolved change with an empty `consumers` list
 *     means "no other project uses this".
 *   - `riskClass` is optional (populated later by #830 / #831); it renders as
 *     "Unclassified" when absent.
 *
 * The whole section is omitted when a requirement has no `databaseChanges`.
 */
import { Fragment } from "react";
import Link from "next/link";
import type {
  GapReportConsumerUsage,
  GapReportDatabaseChange,
  GapReportRiskClass,
  GapReportSchemaConsumer,
} from "@/lib/analysis-api";

interface Props {
  projectId: string;
  changes: GapReportDatabaseChange[] | undefined;
}

/** The `<schema>.<table>.<column>`-style label for an affected object. */
function objectLabel(c: GapReportDatabaseChange): string {
  return c.columnName ? `${c.tableName}.${c.columnName}` : c.tableName;
}

/** A row the engine could not line up against the live schema — an UNVERIFIED claim. */
function isUnverified(c: GapReportDatabaseChange): boolean {
  return c.reconciliation === "table-not-found" || c.reconciliation === "column-not-found";
}

const CHANGE_KIND_LABEL: Record<GapReportDatabaseChange["changeKind"], string> = {
  "add-table": "Add table",
  "add-column": "Add column",
  "alter-column": "Alter column",
  "drop-column": "Drop column",
  reference: "Reference",
};

/** Present tense of how a sibling project touches the object. */
function usageVerb(usage: GapReportConsumerUsage): string {
  return usage === "writtenBy" ? "writes" : "reads";
}

interface RiskCopy {
  label: string;
  tone: string;
  className: string;
}

/**
 * Risk copy + colour. `breaking` is loud (destructive red); `expanding`
 * (additive) is low-risk sky; `neutral` is muted; an ABSENT class is honestly
 * "Unclassified" (risk not scored yet — #830 / #831), never silently "safe".
 * The label text is always present so the state is never colour-only.
 */
const RISK_COPY: Record<GapReportRiskClass, RiskCopy> = {
  breaking: {
    label: "Breaking",
    tone: "breaking",
    className: "border-red-700/60 bg-red-950/50 text-red-300",
  },
  expanding: {
    label: "Expanding",
    tone: "additive",
    className: "border-sky-700/50 bg-sky-950/40 text-sky-300",
  },
  neutral: {
    label: "Neutral",
    tone: "neutral",
    className: "border-zinc-700/60 bg-zinc-900/60 text-zinc-300",
  },
};

const UNCLASSIFIED_RISK: RiskCopy = {
  label: "Unclassified",
  tone: "unclassified",
  className: "border-zinc-700/60 bg-zinc-900/60 text-zinc-400",
};

function riskCopy(riskClass: GapReportRiskClass | undefined): RiskCopy {
  return riskClass ? RISK_COPY[riskClass] : UNCLASSIFIED_RISK;
}

/** Risk badge — text label + colour, so it is never distinguishable by colour alone. */
function RiskBadge({
  riskClass,
}: {
  riskClass: GapReportRiskClass | undefined;
}): React.ReactElement {
  const copy = riskCopy(riskClass);
  const key = riskClass ?? "unclassified";
  return (
    <span
      data-testid={`db-risk-badge-${key}`}
      data-risk={key}
      role="status"
      aria-label={`Risk: ${copy.label}`}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${copy.className}`}
    >
      {copy.label}
    </span>
  );
}

interface ReconCopy {
  label: string;
  className: string;
}

/**
 * Reconciliation against the live schema. `matched` is verified-green; `null`
 * means no live schema was available to check against (muted — still a verified
 * row, just unchecked); the `*-not-found` values are the violet
 * could-not-verify treatment reused from the gap report's #773 language.
 */
const RECON_COPY: Record<NonNullable<GapReportDatabaseChange["reconciliation"]>, ReconCopy> = {
  matched: {
    label: "Matched live schema",
    className: "border-emerald-700/50 bg-emerald-950/40 text-emerald-300",
  },
  "table-not-found": {
    label: "Table not found",
    className: "border-violet-700/50 bg-violet-950/40 text-violet-300",
  },
  "column-not-found": {
    label: "Column not found",
    className: "border-violet-700/50 bg-violet-950/40 text-violet-300",
  },
};

const RECON_UNCHECKED: ReconCopy = {
  label: "Not checked",
  className: "border-zinc-700/60 bg-zinc-900/60 text-zinc-400",
};

function ReconciliationBadge({
  reconciliation,
}: {
  reconciliation: GapReportDatabaseChange["reconciliation"];
}): React.ReactElement {
  const copy = reconciliation ? RECON_COPY[reconciliation] : RECON_UNCHECKED;
  const key = reconciliation ?? "unchecked";
  return (
    <span
      data-testid={`db-recon-badge-${key}`}
      role="status"
      aria-label={`Live-schema reconciliation: ${copy.label}`}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${copy.className}`}
    >
      {copy.label}
    </span>
  );
}

/**
 * The suggested DDL, rendered INERT as text with a persistent, always-visible
 * "review only, never executed" caption. Never `dangerouslySetInnerHTML`.
 * A `null` DDL renders an explicit muted note rather than an empty gap.
 */
function SuggestedDdl({ ddl }: { ddl: string | null }): React.ReactElement {
  if (ddl == null) {
    return (
      <p data-testid="db-ddl-none" className="text-[11px] italic text-zinc-500">
        No suggested DDL for this change.
      </p>
    );
  }
  return (
    <figure data-testid="db-suggested-ddl" className="space-y-1">
      <figcaption
        data-testid="db-ddl-review-label"
        className="text-[11px] font-semibold uppercase tracking-wide text-amber-300"
      >
        Suggested DDL — for review only, never executed
      </figcaption>
      <pre className="overflow-x-auto rounded border border-zinc-800 bg-zinc-950/70 p-2 text-[11px] leading-relaxed text-zinc-200">
        <code>{ddl}</code>
      </pre>
    </figure>
  );
}

/**
 * Cross-project consumers for ONE change. The three states are deliberately
 * distinct: unresolved identity (unknown, with a link to the identity manager),
 * resolved-with-none (genuinely no sibling uses it), and resolved-with-consumers
 * (the sibling projects that read or write it).
 */
function ConsumerSummary({
  change,
  projectId,
}: {
  change: GapReportDatabaseChange;
  projectId: string;
}): React.ReactElement {
  if (!change.identityResolved) {
    return (
      <p data-testid="db-consumers-unknown" className="text-[11px] text-amber-300">
        Cross-project impact unknown — database identity not linked.{" "}
        <Link
          href={`/projects/${projectId}/connections`}
          data-testid="db-identity-manager-link"
          className="underline decoration-dotted underline-offset-2 hover:text-amber-200"
        >
          Link a database identity
        </Link>{" "}
        to see which projects share this object.
      </p>
    );
  }
  const consumers = change.consumers ?? [];
  if (consumers.length === 0) {
    return (
      <p data-testid="db-consumers-none" className="text-[11px] text-zinc-500">
        No other project reads or writes this object.
      </p>
    );
  }
  return (
    <div data-testid="db-consumers-list" className="text-[11px] text-zinc-400">
      <span className="font-medium text-zinc-300">Shared with:</span>
      <ul className="mt-0.5 space-y-0.5">
        {consumers.map((c: GapReportSchemaConsumer, i) => (
          <li key={`${c.projectId}-${c.usage}-${c.objectQualifiedName}-${i}`}>
            <span className="text-zinc-200">{c.projectName}</span> {usageVerb(c.usage)}{" "}
            <span className="font-mono text-zinc-500">{c.objectQualifiedName}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A flattened resolved consumer impact, paired with its change's object + risk. */
interface ConsumerImpact {
  projectId: string;
  projectName: string;
  usage: GapReportConsumerUsage;
  object: string;
  riskClass: GapReportRiskClass | undefined;
}

function flattenConsumerImpacts(changes: GapReportDatabaseChange[]): ConsumerImpact[] {
  const impacts: ConsumerImpact[] = [];
  for (const change of changes) {
    if (!change.identityResolved) continue;
    for (const consumer of change.consumers ?? []) {
      impacts.push({
        projectId: consumer.projectId,
        projectName: consumer.projectName,
        usage: consumer.usage,
        object: objectLabel(change),
        riskClass: change.riskClass,
      });
    }
  }
  return impacts;
}

/**
 * The cross-project impact banner. Two independent, visually distinct parts:
 *   - a consumer banner (loud) — shown ONLY when a resolved change has consumers;
 *   - an unknown-identity notice (muted warning) — shown when any change's
 *     identity is unresolved. It is rendered distinctly from the "resolved but
 *     zero consumers" per-row state so "unknown" is never read as "none".
 */
function CrossProjectBanner({
  changes,
  projectId,
}: {
  changes: GapReportDatabaseChange[];
  projectId: string;
}): React.ReactElement | null {
  const impacts = flattenConsumerImpacts(changes);
  const unresolved = changes.filter((c) => !c.identityResolved);
  if (impacts.length === 0 && unresolved.length === 0) return null;

  const projectNames = Array.from(new Set(impacts.map((i) => i.projectName)));

  return (
    <div className="space-y-2">
      {impacts.length > 0 ? (
        <div
          data-testid="db-cross-project-banner"
          role="note"
          className="space-y-1 rounded border border-amber-700/50 bg-amber-950/30 p-2"
        >
          <p className="text-xs font-semibold text-amber-200">
            Cross-project impact — this change affects {projectNames.length} other{" "}
            {projectNames.length === 1 ? "project" : "projects"}: {projectNames.join(", ")}
          </p>
          <ul className="space-y-0.5">
            {impacts.map((im, i) => (
              <li
                key={`${im.projectId}-${im.object}-${im.usage}-${i}`}
                data-testid="db-cross-project-impact"
                className="text-[11px] text-amber-100/90"
              >
                <span className="font-medium">{im.projectName}</span> {usageVerb(im.usage)}{" "}
                <span className="font-mono">{im.object}</span> —{" "}
                <span data-risk={im.riskClass ?? "unclassified"}>
                  {riskCopy(im.riskClass).label}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {unresolved.length > 0 ? (
        <div
          data-testid="db-cross-project-unknown"
          role="note"
          className="rounded border border-zinc-700/60 bg-zinc-900/50 p-2"
        >
          <p className="text-[11px] text-zinc-400">
            Cross-project impact unknown — database identity not linked for{" "}
            <span className="font-mono text-zinc-300">
              {unresolved.map((c) => objectLabel(c)).join(", ")}
            </span>
            .{" "}
            <Link
              href={`/projects/${projectId}/connections`}
              data-testid="db-cross-project-unknown-link"
              className="underline decoration-dotted underline-offset-2 hover:text-zinc-200"
            >
              Link a database identity
            </Link>{" "}
            to reveal which projects share these tables.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** One accessible table of affected objects (verified OR unverified). */
function ChangesTable({
  changes,
  projectId,
  testId,
  caption,
}: {
  changes: GapReportDatabaseChange[];
  projectId: string;
  testId: string;
  caption: string;
}): React.ReactElement {
  return (
    <table data-testid={testId} className="w-full border-collapse text-left text-xs">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr className="border-b border-zinc-800 text-[10px] uppercase tracking-wide text-zinc-500">
          <th scope="col" className="py-1 pr-2 font-semibold">
            Object
          </th>
          <th scope="col" className="py-1 pr-2 font-semibold">
            Change
          </th>
          <th scope="col" className="py-1 pr-2 font-semibold">
            Reconciliation
          </th>
          <th scope="col" className="py-1 pr-2 font-semibold">
            Confidence
          </th>
          <th scope="col" className="py-1 font-semibold">
            Risk
          </th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c, i) => (
          <Fragment key={`${objectLabel(c)}-${c.changeKind}-${i}`}>
            <tr data-testid="db-change-row" data-object={objectLabel(c)} className="align-top">
              <th scope="row" className="py-1.5 pr-2 font-mono font-normal text-zinc-200">
                {objectLabel(c)}
              </th>
              <td className="py-1.5 pr-2 text-zinc-300">{CHANGE_KIND_LABEL[c.changeKind]}</td>
              <td className="py-1.5 pr-2">
                <ReconciliationBadge reconciliation={c.reconciliation} />
              </td>
              <td className="py-1.5 pr-2 text-zinc-400">{c.confidence.toFixed(2)}</td>
              <td className="py-1.5">
                <RiskBadge riskClass={c.riskClass} />
              </td>
            </tr>
            <tr className="border-b border-zinc-800/70">
              <td colSpan={5} className="space-y-1.5 pb-2">
                <SuggestedDdl ddl={c.suggestedDdl} />
                <ConsumerSummary change={c} projectId={projectId} />
              </td>
            </tr>
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The database-changes section for one requirement. Rendered nothing (null) when
 * the requirement has no `databaseChanges` — no empty state is invented.
 */
export function GapReportSchemaSection({ projectId, changes }: Props): React.ReactElement | null {
  if (!changes || changes.length === 0) return null;

  const verified = changes.filter((c) => !isUnverified(c));
  const unverified = changes.filter(isUnverified);

  return (
    <section data-testid="gap-database-changes" className="space-y-2">
      <h6 className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
        Database changes
      </h6>
      <p className="text-[11px] text-zinc-500">
        The database objects this requirement affects. Suggested DDL is shown for review only and is
        never executed by METIS.
      </p>

      <CrossProjectBanner changes={changes} projectId={projectId} />

      {verified.length > 0 ? (
        <ChangesTable
          changes={verified}
          projectId={projectId}
          testId="db-verified-changes"
          caption="Affected database objects, reconciled against the live schema"
        />
      ) : null}

      {unverified.length > 0 ? (
        <div
          data-testid="db-unverified-changes"
          className="space-y-1.5 rounded border border-violet-800/50 bg-violet-950/20 p-2"
        >
          <h6 className="text-[11px] font-semibold uppercase tracking-wide text-violet-300">
            Unverified against live schema — could not confirm
          </h6>
          <p className="text-[11px] text-violet-200/80">
            These objects were referenced in code but could not be found in the live schema, so the
            change could not be confirmed. Treat them as leads to check, not confirmed changes.
          </p>
          <ChangesTable
            changes={unverified}
            projectId={projectId}
            testId="db-unverified-changes-table"
            caption="Affected database objects that could not be reconciled against the live schema"
          />
        </div>
      ) : null}
    </section>
  );
}
