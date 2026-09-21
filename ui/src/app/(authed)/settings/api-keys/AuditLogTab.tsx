/**
 * Issue #253 — Audit log tab. Lists recent runtime config writes with the
 * actor + timestamp + redacted old/new values.
 *
 * Sensitive keys are stored as `[REDACTED]` server-side; this component
 * surfaces a small lock icon for those rows so the operator immediately sees
 * "this was a secret rotation" vs "this was a tunable change".
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { configApi, type ConfigAuditRow } from "@/lib/settings-api";
import { ApiError } from "@/lib/api-client";

const QUERY_KEY = ["admin", "config", "audit"] as const;

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

export function AuditLogTab() {
  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => configApi.audit({ limit: 50 }),
    retry: false,
  });

  if (q.isLoading) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="config-audit-loading">
        Loading audit log…
      </p>
    );
  }
  if (q.isError) {
    const msg = q.error instanceof ApiError ? q.error.message : "Failed to load audit log";
    return (
      <p
        role="alert"
        className="rounded border border-destructive p-2 text-xs text-destructive"
        data-testid="config-audit-error"
      >
        {msg}
      </p>
    );
  }
  const items: ConfigAuditRow[] = q.data?.items ?? [];
  if (items.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="config-audit-empty">
        No config changes recorded yet.
      </p>
    );
  }

  return (
    <table
      className="w-full text-left text-xs"
      aria-label="Config audit log"
      data-testid="config-audit-table"
    >
      <thead>
        <tr className="text-muted-foreground">
          <th className="py-1 pr-3 font-medium">Time</th>
          <th className="py-1 pr-3 font-medium">Key</th>
          <th className="py-1 pr-3 font-medium">Actor</th>
          <th className="py-1 pr-3 font-medium">Old</th>
          <th className="py-1 pr-3 font-medium">New</th>
        </tr>
      </thead>
      <tbody>
        {items.map((row) => (
          <tr key={row.id} className="border-t" data-testid={`config-audit-row-${row.id}`}>
            <td className="py-1 pr-3 whitespace-nowrap">{formatTimestamp(row.ts)}</td>
            <td className="py-1 pr-3 font-mono">{row.key}</td>
            <td className="py-1 pr-3 font-mono">{row.actorId}</td>
            <td className="py-1 pr-3">
              <RedactedCell value={row.oldValueRedacted} />
            </td>
            <td className="py-1 pr-3">
              <RedactedCell value={row.newValueRedacted} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function RedactedCell({ value }: { value: string }) {
  if (value === "[REDACTED]") {
    return (
      <span aria-label="redacted secret value" title="Sensitive — redacted in audit log">
        🔒 [REDACTED]
      </span>
    );
  }
  if (value === "[unset]") {
    return <span className="text-muted-foreground">[unset]</span>;
  }
  return <code className="font-mono">{value}</code>;
}
