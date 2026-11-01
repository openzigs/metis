/**
 * Epic #1608 (#1626) — the coverage matrix: every product in scope, one row
 * each, with an explicit state. A covering or partial row expands to its
 * repo-stamped citations (`repo · file:line`).
 */
"use client";

import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CoverageRow } from "@/lib/portfolio-coverage";
import { CoverageState } from "./coverage-state";

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function PortfolioCoverageMatrix({ rows }: { rows: CoverageRow[] }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (productId: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });

  return (
    <table className="w-full border-collapse text-sm" data-testid="portfolio-coverage-matrix">
      <caption className="sr-only">Coverage of the requirement by each product in scope</caption>
      <thead>
        <tr className="border-b border-border text-left text-xs uppercase text-muted-foreground">
          <th scope="col" className="py-2 pr-4 font-medium">
            Product
          </th>
          <th scope="col" className="py-2 pr-4 font-medium">
            Coverage
          </th>
          <th scope="col" className="py-2 font-medium">
            Evidence
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const expandable =
            (row.coverage === "covers" || row.coverage === "partial") && row.citations.length > 0;
          const isOpen = open.has(row.productId);
          const panelId = `portfolio-citations-${row.productId}`;
          return (
            <Fragment key={row.productId}>
              <tr
                className="border-b border-border align-top"
                data-testid="portfolio-coverage-row"
                data-coverage={row.coverage}
              >
                <th scope="row" className="py-2 pr-4 text-left font-medium">
                  {row.name ?? (
                    <span className="text-muted-foreground">A product you cannot read</span>
                  )}
                </th>
                <td className="py-2 pr-4">
                  <CoverageState coverage={row.coverage} reason={row.reason} />
                </td>
                <td className="py-2">
                  {expandable ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-expanded={isOpen}
                      aria-controls={panelId}
                      aria-label={`${isOpen ? "Hide" : "Show"} ${plural(row.citations.length, "citation")} for ${row.name ?? "this product"}`}
                      onClick={() => toggle(row.productId)}
                    >
                      {isOpen ? (
                        <ChevronDown className="mr-1 h-4 w-4" aria-hidden />
                      ) : (
                        <ChevronRight className="mr-1 h-4 w-4" aria-hidden />
                      )}
                      {isOpen ? "Hide" : "Show"} {plural(row.citations.length, "citation")}
                    </Button>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </td>
              </tr>
              {expandable && isOpen ? (
                <tr id={panelId} data-testid="portfolio-citations">
                  <td colSpan={3} className="pb-3 pl-4">
                    <ul className="space-y-1 font-mono text-xs">
                      {row.citations.map((c, i) => (
                        <li key={`${c.repo}-${c.location}-${i}`}>
                          {c.repo} · {c.location}
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              ) : null}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}
