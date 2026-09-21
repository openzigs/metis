/**
 * Epic #803 (Epic 09) — Domain Eval per-item field diff.
 *
 * Renders the expected↔predicted requirement alignment for a single corpus
 * item: matched pairs (with per-field comparison + ROUGE-L), missed golden
 * requirements (false negatives), and hallucinated predictions (false
 * positives). Stable test ids + roles so e2e can target rows.
 */
"use client";

import type { DomainItemResult, DomainMatch, DomainRequirement } from "@/lib/eval-api";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export interface DomainFieldDiffProps {
  item: DomainItemResult;
}

interface AlignedRow {
  kind: "match" | "missed" | "hallucinated";
  expected: DomainRequirement | null;
  predicted: DomainRequirement | null;
  match: DomainMatch | null;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function buildRows(item: DomainItemResult): AlignedRow[] {
  const expectedById = new Map(item.expected.map((r) => [r.id, r]));
  const predictedById = new Map(item.predicted.map((r) => [r.id, r]));
  const rows: AlignedRow[] = [];
  for (const m of item.matches) {
    const expected = m.expectedId ? (expectedById.get(m.expectedId) ?? null) : null;
    const predicted = m.predictedId ? (predictedById.get(m.predictedId) ?? null) : null;
    if (m.expectedId && m.predictedId) {
      rows.push({ kind: "match", expected, predicted, match: m });
    } else if (m.expectedId) {
      rows.push({ kind: "missed", expected, predicted: null, match: m });
    } else if (m.predictedId) {
      rows.push({ kind: "hallucinated", expected: null, predicted, match: m });
    }
  }
  return rows;
}

const KIND_LABELS: Record<AlignedRow["kind"], string> = {
  match: "Matched",
  missed: "Missed (false negative)",
  hallucinated: "Extra (false positive)",
};

const KIND_CLASSES: Record<AlignedRow["kind"], string> = {
  match: "border-green-200 bg-green-50",
  missed: "border-amber-200 bg-amber-50",
  hallucinated: "border-red-200 bg-red-50",
};

const FIELDS: { key: keyof DomainRequirement; label: string }[] = [
  { key: "title", label: "Title" },
  { key: "type", label: "Type" },
  { key: "priority", label: "Priority" },
  { key: "description", label: "Description" },
];

function fieldValue(req: DomainRequirement | null, key: keyof DomainRequirement): string {
  if (!req) return "—";
  const v = req[key];
  return v === undefined || v === null ? "—" : String(v);
}

export function DomainFieldDiff({ item }: DomainFieldDiffProps) {
  const rows = buildRows(item);
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid={`domain-diff-empty-${item.itemId}`}>
        No requirements to compare.
      </p>
    );
  }
  return (
    <div
      className="space-y-3"
      data-testid={`domain-field-diff-${item.itemId}`}
      aria-label={`Field diff for ${item.title}`}
    >
      {rows.map((row, i) => (
        <div
          key={`${row.expected?.id ?? "x"}-${row.predicted?.id ?? "x"}-${i}`}
          className={`rounded border p-3 ${KIND_CLASSES[row.kind]}`}
          data-testid={`domain-diff-row-${item.itemId}-${i}`}
          data-kind={row.kind}
        >
          <div className="mb-2 flex items-center justify-between text-xs font-medium">
            <span>{KIND_LABELS[row.kind]}</span>
            {row.match ? (
              <span className="text-muted-foreground">
                title {pct(row.match.titleSimilarity)} · ROUGE-L {pct(row.match.rougeL)}
              </span>
            ) : null}
          </div>
          <Table className="text-xs">
            <TableHeader>
              <TableRow>
                <TableHead className="font-normal">Field</TableHead>
                <TableHead className="font-normal">Expected</TableHead>
                <TableHead className="font-normal">Predicted</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {FIELDS.map((f) => {
                const exp = fieldValue(row.expected, f.key);
                const pred = fieldValue(row.predicted, f.key);
                const differs = exp !== pred;
                return (
                  <TableRow
                    key={f.key}
                    data-field={f.key}
                    data-differs={differs ? "true" : "false"}
                  >
                    <TableCell className="px-2 py-1 align-top text-muted-foreground">
                      {f.label}
                    </TableCell>
                    <TableCell className="px-2 py-1 align-top">{exp}</TableCell>
                    <TableCell className={`px-2 py-1 align-top ${differs ? "font-medium" : ""}`}>
                      {pred}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ))}
    </div>
  );
}
