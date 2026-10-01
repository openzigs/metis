/**
 * #611 (PR #627 review) — a secret over the confirm cap can carry 1,000+
 * bindings, which no admin reviews line by line. This groups the 409's list
 * by binding type and by destination host so the review starts from a few
 * rows; the full list stays below it.
 */
import type { VaultForeignOwner } from "@/lib/vault-api";

type Binding = VaultForeignOwner["bindings"][number];

/** Display names for the binding types the server lists (`rotate-foreign-owner.ts`). */
const TYPE_LABELS: Record<string, string> = {
  db_connector: "DB connector",
  repo_connector: "Repo connector",
  import_source: "Import source",
  mcp_server: "MCP server",
  jira_connection: "Jira connection",
  test_management_connection: "Test-management connection",
};

/** Most host rows shown; the rest are summed into one "more hosts" count. */
export const MAX_HOST_ROWS = 10;

export interface BindingCount {
  key: string;
  label: string;
  count: number;
}

export interface BindingSummary {
  byType: BindingCount[];
  byHost: BindingCount[];
  /** Distinct hosts beyond `MAX_HOST_ROWS`, and how many bindings they hold. */
  moreHosts: { hosts: number; bindings: number };
  /** Bindings whose destination names no network host (a driver, provider or command). */
  withoutHost: number;
}

/** The host a destination sends to, or null when it is not a URL with one. */
export function destinationHost(destination: string | null): string | null {
  if (!destination || !destination.includes("://")) return null;
  try {
    const host = new URL(destination).hostname;
    return host ? host.toLowerCase() : null;
  } catch {
    return null;
  }
}

function tally(keys: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1);
  return counts;
}

/** Most first, then by name, so the order is stable between renders. */
function sorted(counts: Map<string, number>, label: (k: string) => string): BindingCount[] {
  return [...counts]
    .map(([key, count]) => ({ key, label: label(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

export function summarizeBindings(bindings: readonly Binding[]): BindingSummary {
  const byType = sorted(tally(bindings.map((b) => b.type)), (t) => TYPE_LABELS[t] ?? t);
  const hosts: string[] = [];
  let withoutHost = 0;
  for (const b of bindings) {
    const host = destinationHost(b.destination);
    if (host) hosts.push(host);
    else withoutHost += 1;
  }
  const allHosts = sorted(tally(hosts), (h) => h);
  const rest = allHosts.slice(MAX_HOST_ROWS);
  return {
    byType,
    byHost: allHosts.slice(0, MAX_HOST_ROWS),
    moreHosts: { hosts: rest.length, bindings: rest.reduce((n, h) => n + h.count, 0) },
    withoutHost,
  };
}
