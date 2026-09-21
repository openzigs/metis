"use client";

/**
 * SandboxSessionTable — Epic #395 #419.
 *
 * Renders an expandable table of sandbox sessions for a single Run.
 * Columns: provider, vendor sandbox id, wall-clock duration, cost,
 * outcome, createdAt. Cost is rendered in USD (4 decimals) — the API
 * returns micro-USD on the wire to preserve precision.
 */
import * as React from "react";
import { SandboxStatusBadge } from "./SandboxStatusBadge";

export interface SandboxSessionRow {
  id: string;
  provider: string;
  vendorSandboxId: string;
  templateId: string | null;
  vCpus: number;
  memMiB: number;
  createdAt: string;
  destroyedAt: string | null;
  wallClockMs: number | null;
  costMicroUsd: number | null;
  outcome: string | null;
  errorMessage: string | null;
}

export interface SandboxSessionTableProps {
  sessions: readonly SandboxSessionRow[];
  /** When true, render the expanded body. Defaults to false. */
  defaultOpen?: boolean;
}

const MICRO_PER_USD = 1_000_000;

function formatCost(microUsd: number | null): string {
  if (microUsd == null) return "—";
  const usd = microUsd / MICRO_PER_USD;
  return `$${usd.toFixed(4)}`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function SandboxSessionTable({
  sessions,
  defaultOpen = false,
}: SandboxSessionTableProps): React.ReactElement {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <section
      data-testid="sandbox-session-table"
      className="rounded border border-slate-200 dark:border-slate-700"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between p-3 text-left"
        aria-expanded={open}
        data-testid="sandbox-session-table-toggle"
      >
        <div>
          <div className="text-sm font-semibold">Sandbox sessions</div>
          <div className="text-xs text-muted-foreground">
            {sessions.length} session{sessions.length === 1 ? "" : "s"}
          </div>
        </div>
        <span aria-hidden="true" className="text-xs">
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open && (
        <div className="border-t border-slate-200 p-3 dark:border-slate-700">
          {sessions.length === 0 ? (
            <div
              className="text-sm text-muted-foreground"
              data-testid="sandbox-session-table-empty"
            >
              No sandbox sessions recorded for this run.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-muted-foreground">
                    <th className="px-2 py-1">Provider</th>
                    <th className="px-2 py-1">Vendor ID</th>
                    <th className="px-2 py-1">Wall-clock</th>
                    <th className="px-2 py-1">Cost</th>
                    <th className="px-2 py-1">Status</th>
                    <th className="px-2 py-1">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr
                      key={s.id}
                      data-testid={`sandbox-session-row-${s.id}`}
                      data-sandbox-session-id={s.id}
                      className="border-t border-slate-100 dark:border-slate-800"
                    >
                      <td className="px-2 py-1 font-mono">{s.provider}</td>
                      <td className="px-2 py-1 font-mono" title={s.vendorSandboxId}>
                        {s.vendorSandboxId.slice(0, 24)}
                        {s.vendorSandboxId.length > 24 ? "…" : ""}
                      </td>
                      <td className="px-2 py-1 tabular-nums">{formatDuration(s.wallClockMs)}</td>
                      <td
                        className="px-2 py-1 tabular-nums"
                        data-testid={`sandbox-session-cost-${s.id}`}
                      >
                        {formatCost(s.costMicroUsd)}
                      </td>
                      <td className="px-2 py-1">
                        <SandboxStatusBadge outcome={s.outcome} errorMessage={s.errorMessage} />
                      </td>
                      <td className="px-2 py-1">{formatTimestamp(s.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
