"use client";

/**
 * #190 — a generated-document version's heavy artifacts, each fetched from its
 * own endpoint only when the user opens the matching panel. For a
 * full-coverage document the provenance manifest alone is tens of megabytes,
 * so none of this travels with the document detail any more.
 *
 * #196 — the Provenance panel shows a server-computed summary; the full
 * manifest is fetched only when the user asks to download it.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { NOT_CHECKED_REASON_WORDS } from "@metis/shared";
import { apiFetch } from "@/lib/api-client";

/** Changed symbols shown per page. */
export const CHANGED_SYMBOLS_PAGE = 200;

interface ChangedSymbolsPage {
  total: number;
  offset: number;
  items: string[];
}

/** `GET …/provenance/summary` — the fields the panel shows (#196). */
interface ProvenanceSummary {
  revisionId: string;
  version: number;
  generatedAt: string;
  pipeline: string;
  models: { phase1: string; phase2: string };
  sectionCount: number;
  selectedEvidenceCount: number;
  sourceCount: number;
  historicalCitations: { status: string; mode: string };
  /** #995 — per section, the topics a length cap left out. */
  omittedTopics?: Array<{ section: string; topics: string[] }>;
  /** #1223 — a reader BRD's main sections, as checked for code names; absent or empty = not checked. */
  codeIdentifiers?: Array<{
    section: string;
    count: number;
    examples: Array<{ kind: string; text: string }>;
  }>;
  /**
   * #1133 — an architecture document's sections, as checked against the
   * database schema for the names they write as tables or columns; absent or
   * empty = not checked (no schema, or another kind of document).
   */
  schemaClaims?: Array<{
    section: string;
    judged: number;
    /** At most 50 names; `unmatchedCount` is how many there are (#1469). */
    unmatched: string[];
    unmatchedCount?: number;
    notChecked: number;
    /** #1469 — why names were not checked, each reason once. */
    notCheckedWhy?: string[];
    /** #1469 — what the names were compared with; absent on a version recorded before. */
    source?: string;
  }>;
  /** #1070 — a planned document's topic plan; absent = not planned. */
  topicPlan?: {
    budgetChars: number;
    sections: Array<{
      sectionLabel: string;
      kind: string;
      budgetChars: number;
      plannedTopics: number;
      dropped: string[];
      droppedNotListed: number;
    }>;
  };
  /** #1070 — the cross-section consistency check; absent = not run. */
  consistency?: {
    statements: number;
    /** Of those, the ones that had something to be compared with. */
    compared: number;
    findingCount: number;
    findings: ConsistencyFinding[];
  };
}

interface ConsistencyFinding {
  kind: string;
  name: string;
  /** What a prose finding is about, as written ("API token (characters)"). */
  label?: string;
  sections: number;
  forms: number;
  statements: Array<{ section: string; value: string }>;
  source?: { value: string; location: string };
}

/** Save the full manifest as a JSON file. Fetched only on this explicit request. */
async function downloadManifest(base: string, filename: string): Promise<void> {
  const manifest = await apiFetch<unknown>(`${base}/provenance`);
  const blob = new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

type Panel = "symbols" | "provenance" | null;

/** #995 — the topics the length caps left out of the document, by section. */
function OmittedTopics({
  omitted,
  testId,
}: {
  omitted: NonNullable<ProvenanceSummary["omittedTopics"]>;
  testId: string;
}): React.ReactElement | null {
  const count = omitted.reduce((n, entry) => n + entry.topics.length, 0);
  if (count === 0) return null;
  return (
    <div className="mt-1" data-testid={testId}>
      <p className="font-medium">
        {count.toLocaleString()} topic{count === 1 ? "" : "s"} left out for length
      </p>
      <ul className="max-h-48 overflow-y-auto">
        {omitted.map((entry, i) => (
          <li key={`${i}:${entry.section}`}>
            <span className="text-muted-foreground">{entry.section}</span>
            <ul className="list-disc pl-4">
              {entry.topics.map((topic, j) => (
                <li key={`${j}:${topic}`}>{topic}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * #1070 — what the topic plan decided before anything was written: how many
 * topics each reference section was planned within the document's length
 * limit, and how many it left out. The left-out topics themselves are already
 * listed above, as `(not planned)`, so they are counted here, not repeated.
 * Renders nothing for a document that was not planned.
 */
export function TopicPlanSummary({
  plan,
  testId,
}: {
  plan: ProvenanceSummary["topicPlan"];
  testId: string;
}): React.ReactElement | null {
  if (!plan) return null;
  const reference = plan.sections.filter((s) => s.kind === "enumerative");
  const planned = reference.reduce((n, s) => n + s.plannedTopics, 0);
  const leftOut = (s: (typeof plan.sections)[number]): number =>
    s.dropped.length + s.droppedNotListed;
  const dropped = plan.sections.reduce((n, s) => n + leftOut(s), 0);
  return (
    <div className="mt-1" data-testid={testId}>
      <p className="font-medium">
        Topic plan: {planned.toLocaleString()} topic{planned === 1 ? "" : "s"} across{" "}
        {reference.length.toLocaleString()} reference section
        {reference.length === 1 ? "" : "s"}; document length limit about{" "}
        {Math.round(plan.budgetChars / 1000).toLocaleString()}k characters
      </p>
      {dropped === 0 ? (
        <p className="text-muted-foreground">No topic was left out before writing.</p>
      ) : (
        <>
          <p className="text-muted-foreground">
            {dropped.toLocaleString()} topic{dropped === 1 ? "" : "s"} left out before writing, the
            least important ones; they are listed above as &ldquo;(not planned)&rdquo;.
          </p>
          <ul className="list-disc pl-4">
            {plan.sections
              .filter((s) => leftOut(s) > 0)
              .map((s, i) => (
                <li key={`${i}:${s.sectionLabel}`}>
                  {s.sectionLabel}: {s.plannedTopics.toLocaleString()} planned,{" "}
                  {leftOut(s).toLocaleString()} left out
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** One consistency finding as a sentence an analyst can act on. */
function consistencyFindingText(f: ConsistencyFinding): string {
  const what = f.label ?? f.name;
  switch (f.kind) {
    case "conflict":
      return `${f.name} is stated differently from the source${
        f.source ? ` (${f.source.value} at ${f.source.location})` : ""
      }`;
    case "restated":
      return `The formula ${f.name} is written out in ${f.sections} sections, ${f.forms} different way${
        f.forms === 1 ? "" : "s"
      }`;
    case "endpoint":
      return `The endpoint ${f.name} is given ${f.forms} different methods`;
    case "count":
      return `The number of ${what} is given ${f.forms} different ways`;
    case "size":
      return `The size of the ${what} is given ${f.forms} different ways`;
    default:
      return what;
  }
}

/**
 * #1070 — the cross-section consistency check, shown whatever it found: a
 * clean result is an answer too. It compares how values are written and
 * changes nothing in the document. Renders nothing when the check did not run.
 */
export function ConsistencySummary({
  consistency,
  testId,
}: {
  consistency: ProvenanceSummary["consistency"];
  testId: string;
}): React.ReactElement | null {
  if (!consistency) return null;
  const { compared, findingCount, findings } = consistency;
  const across = `${compared.toLocaleString()} statement${compared === 1 ? "" : "s"} compared across sections`;
  return (
    <div className="mt-1" data-testid={testId}>
      <p className="font-medium">
        {findingCount === 0
          ? `Consistency check: no differences found (${across})`
          : `Consistency check: ${findingCount.toLocaleString()} possible inconsistenc${
              findingCount === 1 ? "y" : "ies"
            } (${across})`}
      </p>
      {findings.length > 0 && (
        <ul className="max-h-48 list-disc overflow-y-auto pl-4">
          {findings.map((f, i) => (
            <li key={`${i}:${f.kind}:${f.name}`}>
              {consistencyFindingText(f)}
              <ul className="list-[circle] pl-4 text-muted-foreground">
                {f.statements.map((st, j) => (
                  <li key={`${j}:${st.section}`}>
                    {st.section}: <code className="break-all">{st.value}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {findingCount > findings.length && (
        <p className="text-muted-foreground">
          and {(findingCount - findings.length).toLocaleString()} more, not listed
        </p>
      )}
      {findingCount > 0 && (
        <p className="text-muted-foreground">
          Nothing was changed. Compare the statements with the source.
        </p>
      )}
    </div>
  );
}

/**
 * #1223 — the code names METIS found in a reader BRD's main document, which is
 * signed off by people who do not read code (sign-off rubric SO3). Only the
 * sections that have any are listed; nothing is shown for a document whose
 * main part was not checked.
 */
function CodeIdentifiers({
  checked,
  testId,
}: {
  checked: NonNullable<ProvenanceSummary["codeIdentifiers"]>;
  testId: string;
}): React.ReactElement | null {
  if (checked.length === 0) return null;
  const flagged = checked.filter((entry) => entry.count > 0);
  // Each section counts its own distinct names, so a name used in two sections
  // is two flags: the label says so rather than claim a document-wide count.
  const total = flagged.reduce((n, entry) => n + entry.count, 0);
  const sections = flagged.length;
  return (
    <div className="mt-1" data-testid={testId}>
      <p className="font-medium">
        {total === 0
          ? "No code names in the main document"
          : `${total.toLocaleString()} code name${total === 1 ? "" : "s"} flagged in ${sections.toLocaleString()} main section${sections === 1 ? "" : "s"} (counted per section)`}
      </p>
      {flagged.length > 0 && (
        <ul className="max-h-48 overflow-y-auto">
          {flagged.map((entry, i) => (
            <li key={`${i}:${entry.section}`}>
              <span className="text-muted-foreground">
                {entry.section} ({entry.count.toLocaleString()})
              </span>
              <ul className="list-disc pl-4">
                {entry.examples.map((example, j) => (
                  <li key={`${j}:${example.text}`}>
                    <code className="break-all">{example.text}</code>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const plural = (n: number, one: string, many: string): string =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** #1469 — what the schema check compared the names with, as the panel says it. */
function schemaSourceName(source: string | undefined): string {
  switch (source) {
    case "live-schema":
      return "the database schema";
    case "schema-graph":
      return "the stored database schema";
    case "repository-sql":
      return "the repository's SQL files";
    default:
      // A version recorded before #1469 does not say which it was.
      return "the schema";
  }
}

/** #1469 — a reason in the words the document's own note uses (`@metis/shared`). */
const notCheckedWords = (why: string): string =>
  (NOT_CHECKED_REASON_WORDS as Readonly<Record<string, string>>)[why] ?? why;

/**
 * #1133 — what the schema check found in an architecture document: per
 * section, how many table and column names were compared with the database
 * schema, the ones it does not have (each is marked "not in schema" in the
 * text), and how many could not be checked. Nothing is shown for a document
 * that was not checked. #1469 — it names what the names were compared with
 * (the database, a stored schema or the repository's SQL), counts every
 * unmatched name though only 50 per section are listed, and never says every
 * name matched while one could not be checked.
 */
function SchemaClaims({
  checked,
  testId,
}: {
  checked: NonNullable<ProvenanceSummary["schemaClaims"]>;
  testId: string;
}): React.ReactElement | null {
  const sections = checked.filter((entry) => entry.judged > 0 || entry.notChecked > 0);
  if (sections.length === 0) return null;
  // #1469 — the record's list is capped; its count is not.
  const countOf = (entry: (typeof sections)[number]): number =>
    Math.max(entry.unmatchedCount ?? 0, entry.unmatched.length);
  const judged = sections.reduce((n, entry) => n + entry.judged, 0);
  const unmatched = sections.reduce((n, entry) => n + countOf(entry), 0);
  const notChecked = sections.reduce((n, entry) => n + entry.notChecked, 0);
  const source = schemaSourceName(sections.find((entry) => entry.source)?.source);
  const reasons = [...new Set(sections.flatMap((entry) => entry.notCheckedWhy ?? []))].map(
    notCheckedWords,
  );
  const unchecked = notChecked > 0 ? `; ${notChecked.toLocaleString()} could not be checked` : "";
  const heading =
    judged === 0
      ? `Schema check: no table or column name could be checked against ${source}`
      : unmatched > 0
        ? `Schema check: ${plural(unmatched, "name", "names")} not in ${source}, of ${plural(judged, "table or column name", "table and column names")} checked${unchecked}`
        : notChecked > 0
          ? `Schema check: ${plural(judged, "table or column name", "table and column names")} matched ${source}${unchecked}`
          : `Schema check: every table and column name checked (${judged.toLocaleString()}) matches ${source}`;
  return (
    <div className="mt-1" data-testid={testId}>
      <p className="font-medium">{heading}</p>
      {notChecked > 0 && (
        <p className="text-muted-foreground">
          {reasons.length > 0
            ? `Could not be checked: ${reasons.join("; ")}`
            : // A version recorded before #1469 kept no reasons.
              "Could not be checked (reasons were not recorded for this version)"}
        </p>
      )}
      <ul className="max-h-48 overflow-y-auto">
        {sections.map((entry, i) => (
          <li key={`${i}:${entry.section}`}>
            <span className="text-muted-foreground">
              {entry.section}: {plural(entry.judged, "name", "names")} checked
              {countOf(entry) > 0 && `, ${countOf(entry).toLocaleString()} not in schema`}
              {countOf(entry) > entry.unmatched.length &&
                ` (showing the first ${entry.unmatched.length.toLocaleString()})`}
              {entry.notChecked > 0 &&
                `, ${entry.notChecked.toLocaleString()} could not be checked`}
            </span>
            {entry.unmatched.length > 0 && (
              <ul className="list-disc pl-4">
                {entry.unmatched.map((name) => (
                  <li key={name}>
                    <code className="break-all">{name}</code>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function VersionArtifacts({
  projectId,
  docId,
  versionId,
  version,
}: {
  projectId: string;
  docId: string;
  versionId: string;
  version: number;
}): React.ReactElement {
  const [open, setOpen] = useState<Panel>(null);
  const base = `/projects/${projectId}/docs/${docId}/versions/${versionId}`;

  // Versions are immutable, so neither artifact ever goes stale.
  const symbols = useQuery<ChangedSymbolsPage>({
    queryKey: ["generated-docs", projectId, docId, "version", versionId, "changed-symbols"],
    queryFn: () =>
      apiFetch<ChangedSymbolsPage>(`${base}/changed-symbols?limit=${CHANGED_SYMBOLS_PAGE}`),
    enabled: open === "symbols",
    staleTime: Infinity,
  });
  const provenance = useQuery<ProvenanceSummary>({
    queryKey: ["generated-docs", projectId, docId, "version", versionId, "provenance-summary"],
    queryFn: () => apiFetch<ProvenanceSummary>(`${base}/provenance/summary`),
    enabled: open === "provenance",
    staleTime: Infinity,
  });
  const [download, setDownload] = useState<"idle" | "busy" | "failed">("idle");
  const onDownload = () => {
    setDownload("busy");
    downloadManifest(base, `provenance-v${version}.json`).then(
      () => setDownload("idle"),
      () => setDownload("failed"),
    );
  };

  const toggle = (panel: Exclude<Panel, null>) => setOpen((cur) => (cur === panel ? null : panel));

  return (
    <div className="pl-4 text-xs">
      <div className="flex gap-3">
        <button
          type="button"
          className="text-muted-foreground underline hover:text-foreground"
          aria-expanded={open === "symbols"}
          onClick={() => toggle("symbols")}
          data-testid={`version-symbols-toggle-${versionId}`}
        >
          Changed symbols
        </button>
        <button
          type="button"
          className="text-muted-foreground underline hover:text-foreground"
          aria-expanded={open === "provenance"}
          onClick={() => toggle("provenance")}
          data-testid={`version-provenance-toggle-${versionId}`}
        >
          Provenance
        </button>
      </div>

      {open === "symbols" && (
        <div className="mt-1 rounded border p-2" data-testid={`version-symbols-${versionId}`}>
          {symbols.isLoading && <p role="status">Loading changed symbols…</p>}
          {symbols.isError && <p role="alert">Could not load the changed symbols.</p>}
          {symbols.data && (
            <>
              <p className="mb-1 font-medium">
                {symbols.data.total === 0
                  ? `v${version} lists no changed symbols.`
                  : `${symbols.data.total.toLocaleString()} changed symbol${
                      symbols.data.total === 1 ? "" : "s"
                    } in v${version}`}
              </p>
              {symbols.data.items.length > 0 && (
                <ul className="max-h-48 overflow-y-auto font-mono">
                  {symbols.data.items.map((name, i) => (
                    <li key={`${i}:${name}`} className="truncate" title={name}>
                      {name}
                    </li>
                  ))}
                </ul>
              )}
              {symbols.data.total > symbols.data.items.length && (
                <p className="mt-1 text-muted-foreground">
                  Showing the first {symbols.data.items.length.toLocaleString()}.
                </p>
              )}
            </>
          )}
        </div>
      )}

      {open === "provenance" && (
        <div className="mt-1 rounded border p-2" data-testid={`version-provenance-${versionId}`}>
          {provenance.isLoading && <p role="status">Loading provenance…</p>}
          {provenance.isError && <p role="alert">Could not load the provenance manifest.</p>}
          {provenance.data && (
            <>
              <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
                <dt className="text-muted-foreground">Revision</dt>
                <dd className="font-mono">{provenance.data.revisionId}</dd>
                <dt className="text-muted-foreground">Generated</dt>
                <dd>{new Date(provenance.data.generatedAt).toLocaleString()}</dd>
                <dt className="text-muted-foreground">Pipeline</dt>
                <dd>{provenance.data.pipeline}</dd>
                <dt className="text-muted-foreground">Models</dt>
                <dd>
                  {provenance.data.models.phase1} / {provenance.data.models.phase2}
                </dd>
                <dt className="text-muted-foreground">Sections</dt>
                <dd>{provenance.data.sectionCount.toLocaleString()}</dd>
                <dt className="text-muted-foreground">Evidence</dt>
                <dd>
                  {provenance.data.selectedEvidenceCount.toLocaleString()} selected from{" "}
                  {provenance.data.sourceCount.toLocaleString()} sources
                </dd>
                <dt className="text-muted-foreground">Citations</dt>
                <dd>
                  {provenance.data.historicalCitations.status} (
                  {provenance.data.historicalCitations.mode})
                </dd>
              </dl>
              <OmittedTopics
                omitted={provenance.data.omittedTopics ?? []}
                testId={`version-omitted-topics-${versionId}`}
              />
              <TopicPlanSummary
                plan={provenance.data.topicPlan}
                testId={`version-topic-plan-${versionId}`}
              />
              <ConsistencySummary
                consistency={provenance.data.consistency}
                testId={`version-consistency-${versionId}`}
              />
              <CodeIdentifiers
                checked={provenance.data.codeIdentifiers ?? []}
                testId={`version-code-identifiers-${versionId}`}
              />
              <SchemaClaims
                checked={provenance.data.schemaClaims ?? []}
                testId={`version-schema-claims-${versionId}`}
              />
              <button
                type="button"
                className="mt-1 text-muted-foreground underline hover:text-foreground disabled:opacity-50"
                onClick={onDownload}
                disabled={download === "busy"}
              >
                Download full manifest
              </button>
              {download === "failed" && <p role="alert">Could not download the manifest.</p>}
            </>
          )}
        </div>
      )}
    </div>
  );
}
