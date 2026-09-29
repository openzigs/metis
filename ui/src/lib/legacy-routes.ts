/**
 * #31 — one home per concept. Every page retired by the merge of Settings and
 * Admin, and by giving skills, agents, MCP servers and usage one page each,
 * resolves here to its replacement so bookmarks and deep links keep working.
 * The retired routes are thin server pages that call `redirect()` with this.
 */

export type SearchParamsInput = Record<string, string | string[] | undefined>;

/** Retired path (no trailing slash) → canonical target. */
const EXACT: Readonly<Record<string, string>> = {
  "/admin": "/settings",
  "/admin/workspaces": "/settings/workspaces",
  "/admin/auth": "/settings/auth",
  "/admin/embeddings": "/settings/embeddings",
  "/admin/mcp": "/settings/mcp?tab=servers",
  "/admin/usage": "/settings/usage?scope=platform",
  "/admin/skills": "/library?tab=skills",
  "/skills": "/library?tab=skills",
  "/admin/agents": "/library?tab=agents",
  "/agents": "/library?tab=agents",
  "/settings/agents": "/library?tab=agents",
};

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function target(path: string): string {
  const exact = EXACT[path];
  if (exact) return exact;

  const workspace = /^\/admin\/workspaces\/([^/]+)\/settings$/.exec(path);
  if (workspace) return `/settings/workspaces/${workspace[1]}`;

  const usage = /^\/projects\/([^/]+)\/usage$/.exec(path);
  if (usage) {
    const q = new URLSearchParams({ scope: "project", projectId: decodeSegment(usage[1]!) });
    return `/settings/usage?${q.toString()}`;
  }

  const finops = /^\/workspaces\/([^/]+)\/finops$/.exec(path);
  if (finops) {
    const q = new URLSearchParams({ scope: "workspace", workspaceId: decodeSegment(finops[1]!) });
    return `/settings/usage?${q.toString()}`;
  }

  if (path.startsWith("/admin/")) return "/settings";
  return path;
}

/**
 * The canonical URL for a retired `pathname`, carrying the caller's query
 * through. The target's own query keys win over the caller's, so an old
 * `?tab=` cannot point the new page at a tab it does not have.
 */
export function legacyRedirect(pathname: string, searchParams: SearchParamsInput = {}): string {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const dest = target(path);
  const [base, query = ""] = dest.split("?", 2) as [string, string?];
  const params = new URLSearchParams(query);
  for (const [key, raw] of Object.entries(searchParams)) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value === undefined || value === "" || params.has(key)) continue;
    params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
