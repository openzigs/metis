/**
 * Epic #159 (#166) — Impact analyses list.
 *
 * Lists every impact analysis the caller can see and links into each report.
 */
"use client";

import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useImpactAnalyses } from "@/lib/impact-analysis-hooks";

const STATUS_VARIANT: Record<string, "destructive" | "default" | "secondary" | "outline"> = {
  completed: "default",
  running: "secondary",
  pending: "secondary",
  failed: "destructive",
};

function formatDate(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export default function ImpactAnalysesPage() {
  const { data, isLoading, isError } = useImpactAnalyses();
  const analyses = data ?? [];

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="impact-list-root">
      <header className="flex items-center justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold">Impact analysis</h1>
          <p className="text-sm text-muted-foreground">
            Trace requirement changes to affected code across multiple projects. (To synthesize
            requirements for a single project, use that project&apos;s Requirements Analysis tab.)
          </p>
        </div>
        <Button asChild data-testid="impact-list-new">
          <Link href="/impact-analyses/new">New analysis</Link>
        </Button>
      </header>

      {isLoading ? (
        <p className="text-sm text-muted-foreground" data-testid="impact-list-loading">
          Loading analyses…
        </p>
      ) : isError ? (
        <Card
          className="border-destructive p-4 text-sm text-destructive"
          data-testid="impact-list-error"
        >
          Could not load impact analyses.
        </Card>
      ) : analyses.length === 0 ? (
        <Card
          className="p-6 text-center text-sm text-muted-foreground"
          data-testid="impact-list-empty"
        >
          No impact analyses yet. Start one to map a requirement change to code.
        </Card>
      ) : (
        <Card data-testid="impact-list-table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Projects</TableHead>
                <TableHead>Impacted symbols</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">Completed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {analyses.map((a) => (
                <TableRow key={a.id} data-testid={`impact-list-row-${a.id}`}>
                  <TableCell>
                    <Link
                      href={`/impact-analyses/${a.id}`}
                      className="inline-flex items-center gap-1.5 hover:underline"
                      data-testid={`impact-list-link-${a.id}`}
                    >
                      <Badge variant={STATUS_VARIANT[a.status] ?? "outline"}>{a.status}</Badge>
                      {/* #965 — flag re-run rows so drift lineage is visible in the list. */}
                      {a.rerunOfId ? (
                        <Badge variant="outline" data-testid={`impact-list-rerun-${a.id}`}>
                          re-run
                        </Badge>
                      ) : null}
                    </Link>
                  </TableCell>
                  <TableCell>{a.projectCount}</TableCell>
                  <TableCell>{a.totalImpactedSymbols}</TableCell>
                  <TableCell>{formatDate(a.startedAt)}</TableCell>
                  <TableCell className="text-right">{formatDate(a.completedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
