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
  // #2337 — an alias no navigation linked; Configuration carries the tab.
  "/settings/audit": "/settings/api-keys?tab=audit",
  // #2353 — Products is a section of the Portfolio tab. A product's own page,
  // `/products/<id>`, kept its URL.
  "/products": "/portfolio?tab=products",
  // #2353 — the global connector catalogues are gone: each project's Knowledge
  // tab lists its own connections. With no project named, the project list.
  "/repositories": "/projects",
  "/databases": "/projects",
  // #2350 — Activity → Sessions is chat's history list.
  "/sessions": "/chat",
};

/** #2353 — retired cross-project catalogues that a named project narrows to its Knowledge tab. */
const CONNECTOR_CATALOGUES = new Set(["/repositories", "/databases"]);

/**
 * #2353 — the shape of a project id (a cuid, or any other id made of letters,
 * digits, `-` and `_`). Anything else, `.` and `..` included, names no project.
 */
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/;

function firstValue(raw: string | string[] | undefined): string | undefined {
  return Array.isArray(raw) ? raw[0] : raw;
}

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
  // #2353 — a project in context (`?projectId=`) opens that project's
  // Knowledge tab. Only an id of the project-id shape goes into the path, so
  // `.`, `..`, `/`, `?` and `#` cannot move the redirect off that segment;
  // anything else opens the project list, carrying nothing. No link in the app
  // ever put `?projectId=` here, so a real bookmark lands on the project list.
  if (CONNECTOR_CATALOGUES.has(path)) {
    const projectId = firstValue(searchParams.projectId);
    return projectId && PROJECT_ID.test(projectId)
      ? `/projects/${projectId}/connections`
      : "/projects";
  }

  const dest = target(path);
  const [base, query = ""] = dest.split("?", 2) as [string, string?];
  const params = new URLSearchParams(query);
  for (const [key, raw] of Object.entries(searchParams)) {
    const value = firstValue(raw);
    if (value === undefined || value === "" || params.has(key)) continue;
    params.set(key, value);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}
