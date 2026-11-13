"use client";

/**
 * Issue #2230 (Epic #2227) — the document reader's coverage report.
 *
 * With the document reader on, Requirements Analysis reads each selected
 * document in full instead of ten retrieved chunks. This panel says what it
 * read: every document, every section, and what came out of each, so an
 * analyst can tell "METIS read this section and found nothing" from "METIS
 * never read it". A section that produced nothing says so; a document or
 * section that could not be read says so in amber, with the reason.
 *
 * Renders nothing when the reader did not run (no `documentReading`).
 *
 * #2280 — a document whose saved reading was reused (its file, the reader and
 * the model unchanged) says so, with when and with which model it was read.
 */
import {
  DOCUMENT_STATEMENT_KINDS,
  type AnalysisCapability,
  type DocumentReadingDocument,
  type DocumentReadingSection,
  type DocumentStatementKind,
} from "@metis/shared";

interface Props {
  capability: AnalysisCapability | null;
}

const KIND_TEXT: Record<DocumentStatementKind, [string, string]> = {
  requirement: ["requirement", "requirements"],
  constraint: ["constraint", "constraints"],
  "business-rule": ["business rule", "business rules"],
  assumption: ["assumption", "assumptions"],
  definition: ["definition", "definitions"],
  background: ["background statement", "background statements"],
  example: ["example", "examples"],
};

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `2 requirements, 1 business rule`, in the kinds' order. */
export function describeKinds(kinds: DocumentReadingSection["kinds"]): string {
  return DOCUMENT_STATEMENT_KINDS.filter((k) => (kinds[k] ?? 0) > 0)
    .map((k) => plural(kinds[k]!, ...KIND_TEXT[k]))
    .join(", ");
}

/** #2280 — the line under a document whose saved reading was reused. */
export function reusedText(reused: NonNullable<DocumentReadingDocument["reused"]>): string {
  return `Not read again: the reading saved on ${reused.readAt.slice(0, 10)} (read with ${reused.model}) was reused, because the file has not changed. Start a new analysis with "Read the documents again" for a fresh reading.`;
}

/**
 * #2361 — a read section that produced nothing because its statements were
 * repeats of later sections (an overview): its content was merged, not missed.
 */
export function mergedOnly(section: DocumentReadingSection): boolean {
  return section.status === "read" && section.statements === 0 && !!section.mergedInto?.length;
}

function SectionLine({ section }: { section: DocumentReadingSection }): React.ReactElement {
  if (section.status === "unread") {
    return (
      <li className="text-xs text-warning" data-testid="document-coverage-section">
        <span>{section.heading}</span> — not read: the model&apos;s reply could not be read, or left
        this section out even when asked again.
      </li>
    );
  }
  const said =
    section.statements > 0
      ? describeKinds(section.kinds)
      : mergedOnly(section)
        ? `read; what it says is set out in full in ${section.mergedInto!.join("; ")}`
        : "nothing extracted";
  return (
    <li
      className={`text-xs ${section.statements === 0 ? "text-muted-foreground" : "text-foreground"}`}
      data-testid="document-coverage-section"
    >
      <span>{section.heading}</span> — {said}
    </li>
  );
}

function DocumentEntry({ doc }: { doc: DocumentReadingDocument }): React.ReactElement {
  if (doc.status === "unread") {
    return (
      <li className="text-xs text-warning" data-testid={`document-coverage-${doc.documentId}`}>
        <span className="font-medium">{doc.filename}</span> — not read. {doc.reason}
      </li>
    );
  }
  const unreadSections = doc.sections.filter((s) => s.status === "unread").length;
  const empty = doc.sections.filter(
    (s) => s.status === "read" && s.statements === 0 && !mergedOnly(s),
  ).length;
  return (
    <li className="space-y-1" data-testid={`document-coverage-${doc.documentId}`}>
      <p className="text-xs text-foreground">
        <span className="font-medium">{doc.filename}</span> —{" "}
        {plural(doc.requirements, "requirement", "requirements")} (with constraints and business
        rules) from {plural(doc.sections.length, "section", "sections")}
        {doc.mode === "sectioned" ? ", read section by section (too long to read at once)" : ""}.
        {empty > 0 ? ` ${plural(empty, "section", "sections")} produced nothing.` : ""}
      </p>
      {doc.reused ? (
        <p className="text-xs text-muted-foreground" data-testid="document-coverage-reused">
          {reusedText(doc.reused)}
        </p>
      ) : null}
      {unreadSections > 0 ? (
        <p className="text-xs text-warning">
          {plural(unreadSections, "section was", "sections were")} not read: the model&apos;s reply
          could not be read, or left them out even when asked again.
        </p>
      ) : null}
      {doc.droppedUnverified > 0 ? (
        <p className="text-xs text-warning">
          {plural(doc.droppedUnverified, "statement was", "statements were")} left out because the
          passage quoted for it is not in the document.
        </p>
      ) : null}
      {doc.merge === "failed" ? (
        <p className="text-xs text-warning">
          Repeats were not removed (the check across sections did not complete), so a requirement
          may appear twice.
        </p>
      ) : null}
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          What was read from each section
        </summary>
        <ul className="mt-1 space-y-0.5 pl-3">
          {doc.sections.map((s, i) => (
            <SectionLine key={`${i}-${s.heading}`} section={s} />
          ))}
        </ul>
      </details>
    </li>
  );
}

export function DocumentCoveragePanel({ capability }: Props): React.ReactElement | null {
  const documents = capability?.documentReading?.documents;
  if (!documents || documents.length === 0) return null;
  return (
    <div data-testid="document-coverage-panel" className="space-y-2">
      <h4 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        Documents read in full
      </h4>
      <ul className="space-y-2">
        {documents.map((d) => (
          <DocumentEntry key={d.documentId} doc={d} />
        ))}
      </ul>
    </div>
  );
}
