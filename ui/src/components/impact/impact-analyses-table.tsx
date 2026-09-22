/**
 * The impact-analysis runs table — Epic #159 (#166). Shared by the global list
 * (`/impact-analyses`) and, since #61, a project's own Impact Analysis page.
 */
import Link from "next/link";
import type { ImpactAnalysisSummary } from "@metis/shared";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

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

export function ImpactAnalysesTable({ analyses }: { analyses: ImpactAnalysisSummary[] }) {
  return (
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
  );
}
