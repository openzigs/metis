/**
 * #271 — the page-level part of the header breadcrumb: Section › Page inside a
 * project, or the sidebar entry › Page elsewhere. The Workspace and Project
 * switchers that precede it are rendered by `components/layout/breadcrumbs`.
 *
 * The last crumb is the current page and has no `href`; every crumb before it
 * links to its landing page.
 */
import { NAV_DESTINATIONS, isActiveRoute } from "./navigation";
import { SETTINGS_NAV } from "./settings-nav";
import {
  getProjectTabModel,
  isProjectTabActive,
  resolveActiveProjectTab,
} from "@/components/projects/project-tabs";

export interface Crumb {
  label: string;
  /** Absent on the last crumb, which is the current page. */
  href?: string;
}

/** Ids (numbers, uuids, cuids) are not labels a person can read. */
const ID_LIKE = /^\d+$|^[0-9a-f-]{16,}$|^[a-z0-9_-]{20,}$/i;

/** What a detail page under `/<parent>/<id>` is called. */
const DETAIL_LABEL: Record<string, (id: string) => string> = {
  pulls: (id) => `#${id}`,
  scans: () => "Scan",
  baselines: () => "Baseline",
  discussions: () => "Discussion",
  repositories: () => "Repository",
  runs: () => "Run",
  reviews: () => "Review",
  products: () => "Product",
  "impact-analyses": () => "Analysis",
  leaderboard: () => "Run",
  workspaces: () => "Workspace",
};

function humanize(segment: string): string {
  let text = segment;
  try {
    text = decodeURIComponent(segment);
  } catch {
    // keep the raw segment
  }
  text = text.replace(/[-_]+/g, " ").trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The label for the last segment of a route below a known page. */
export function leafLabel(segment: string, parent: string | undefined): string {
  const detail = parent ? DETAIL_LABEL[parent] : undefined;
  if (detail && (ID_LIKE.test(segment) || parent === "pulls")) return detail(segment);
  if (ID_LIKE.test(segment)) return "Details";
  return humanize(segment);
}

/** Crumbs for `matchedHref`'s page, plus a leaf when `path` goes deeper. */
function withLeaf(path: string, matchedHref: string, trail: Crumb[]): Crumb[] {
  const rest = path.slice(matchedHref.length).split("/").filter(Boolean);
  if (rest.length === 0) {
    // The matched page IS the current page: drop its link.
    const last = trail[trail.length - 1];
    return [...trail.slice(0, -1), { label: last.label }];
  }
  const parent = rest.length > 1 ? rest[rest.length - 2] : matchedHref.split("/").pop();
  return [...trail, { label: leafLabel(rest[rest.length - 1], parent) }];
}

export function pageCrumbs(pathname: string): Crumb[] {
  const path = pathname.replace(/\/+$/, "") || "/";

  const project = path.match(/^\/projects\/([^/]+)(?:\/|$)/);
  if (project) {
    const model = getProjectTabModel(project[1]);
    const base = model.sections[0].href;
    const active = resolveActiveProjectTab(path, model);
    if (!active) return [];
    const { section, item } = active;
    if (section.id === "overview") return [{ label: section.label }];

    const candidates = [item?.href, section.href, ...(section.routes ?? [])].filter(
      (href): href is string => !!href && isProjectTabActive(path, href, base),
    );
    const matched = candidates.sort((a, b) => b.length - a.length)[0] ?? section.href;
    const trail: Crumb[] = [{ label: section.label, href: section.href }];
    if (item) trail.push({ label: item.label, href: item.href });
    // A route reached from inside the section (issue sync, the repo scanner)
    // is not in the sub-nav: on the route itself, it is the page.
    if (!item && matched !== section.href && path === matched) {
      return [...trail, { label: leafLabel(matched.split("/").pop() ?? "", undefined) }];
    }
    return withLeaf(path, matched, trail);
  }

  const nav = NAV_DESTINATIONS.filter((n) => isActiveRoute(path, n.href)).sort(
    (a, b) => b.href.length - a.href.length,
  )[0];
  if (!nav) return [];
  // #545 — a Settings section is named by the settings nav ("MCP servers"),
  // not by its URL segment ("Mcp").
  const section =
    nav.href === "/settings"
      ? SETTINGS_NAV.find((item) => item.href === path && item.href !== "/settings")
      : undefined;
  if (section) return [{ label: nav.label, href: nav.href }, { label: section.label }];
  return withLeaf(path, nav.href, [{ label: nav.label, href: nav.href }]);
}
