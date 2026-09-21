"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, MoreHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A single navigable destination. */
export interface ProjectTabLink {
  href: string;
  label: string;
}

/** A primary tab — either a direct link or a labeled group of links. */
export type ProjectPrimaryTab =
  | { kind: "link"; label: string; href: string }
  | { kind: "group"; label: string; items: ProjectTabLink[] };

export interface ProjectTabModel {
  /** ≤ ~5 primary tabs shown inline on desktop. */
  primary: ProjectPrimaryTab[];
  /** Secondary destinations tucked into the "More" overflow menu. */
  overflow: ProjectTabLink[];
}

/**
 * N2 (#142): collapse the former 17-item horizontal-scroll tab bar into a small
 * set of primary tabs plus a "More" overflow menu. Every original destination
 * remains reachable. The index tab is labeled "Overview" and Documents is split
 * out to its own destination (N3 #141).
 */
/** Options controlling which permission-gated entries appear in the model. */
export interface ProjectTabModelOptions {
  /**
   * #469 — when the viewer holds `project.update`, surface a "Skills" entry that
   * opens the per-project skill allowlist (`/library?projectId=<id>`). Without
   * the permission the entry is omitted, keeping the UI honest with the
   * server-side `project.update` gate on the PUT endpoint.
   */
  canManageSkills?: boolean;
}

export function getProjectTabModel(
  projectId: string,
  options: ProjectTabModelOptions = {},
): ProjectTabModel {
  const base = `/projects/${projectId}`;
  const docsItems: ProjectTabLink[] = [
    { href: `${base}/documentation`, label: "Documentation" },
    { href: `${base}/settings/templates`, label: "Templates" },
  ];
  // #469 — reachable entry point for the per-project skill allowlist. The
  // Library page reads `?projectId` to render the per-project toggles; nothing
  // else in the app linked there, so the toggles were unreachable. Gated on
  // `project.update` to mirror the PUT endpoint's RBAC.
  if (options.canManageSkills) {
    docsItems.push({ href: `/library?projectId=${projectId}`, label: "Skills" });
  }
  return {
    primary: [
      { kind: "link", label: "Overview", href: base },
      { kind: "link", label: "Documents", href: `${base}/documents` },
      { kind: "link", label: "Analysis", href: `${base}/analysis` },
      // #371 (Epic #370, Phase 1): Spec Kit is a planning/requirements workflow
      // — the BA/PM "author the intent" front-door (spec → plan → tasks) that
      // feeds the Analysis → requirements pipeline — not documentation. It now
      // sits as a primary tab immediately after Analysis instead of inside the
      // "Docs" group. The canonical URL `/projects/[id]/spec-kit` is UNCHANGED,
      // so NO `next.config.mjs` redirect is required (a redirect would only be
      // needed if the path itself had moved). The route's continued
      // reachability is guarded by a flattenProjectTabs test in
      // ui/tests/project-tabs.test.tsx.
      { kind: "link", label: "Spec Kit", href: `${base}/spec-kit` },
      // Epic #475 (#486) — collaborative multi-analyst discussions with an AI
      // participant. A project-scoped realtime room, NOT a top-level route, so
      // it lives as a project tab (no entry is added to the global sidebar).
      { kind: "link", label: "Discussions", href: `${base}/discussions` },
      {
        kind: "group",
        label: "Code",
        items: [
          { href: `${base}/overview`, label: "Code Overview" },
          { href: `${base}/changes`, label: "Changes" },
          { href: `${base}/pulls`, label: "Pull Requests" },
        ],
      },
      {
        kind: "group",
        label: "Quality",
        items: [
          { href: `${base}/rule-sets`, label: "Bug Rules" },
          { href: `${base}/scans`, label: "Bug Scans" },
          { href: `${base}/test-coverage`, label: "Test Coverage" },
        ],
      },
      {
        kind: "group",
        label: "Docs",
        items: docsItems,
      },
    ],
    overflow: [
      // Epic #609 (#620) — immutable requirement baselines (list/detail/compare).
      { href: `${base}/baselines`, label: "Baselines" },
      { href: `${base}/connections`, label: "Connections" },
      { href: `${base}/jira`, label: "Jira" },
      { href: `${base}/import`, label: "Import" },
      { href: `${base}/publish`, label: "Publish" },
      { href: `${base}/plugins`, label: "Plugins" },
      { href: `${base}/usage`, label: "Usage" },
    ],
  };
}

/** All destinations flattened — handy for tests / reachability checks. */
export function flattenProjectTabs(model: ProjectTabModel): ProjectTabLink[] {
  const links: ProjectTabLink[] = [];
  for (const tab of model.primary) {
    if (tab.kind === "link") links.push({ href: tab.href, label: tab.label });
    else links.push(...tab.items);
  }
  links.push(...model.overflow);
  return links;
}

/** Active when the link is the project index (exact) or a section prefix. */
export function isProjectTabActive(pathname: string, href: string, projectBase: string): boolean {
  if (href === projectBase) return pathname === projectBase;
  return pathname === href || pathname.startsWith(href + "/");
}

const tabBase =
  "inline-flex items-center gap-1 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function tabClass(active: boolean): string {
  return cn(
    tabBase,
    active
      ? "border-primary text-foreground"
      : "border-transparent text-muted-foreground hover:border-muted-foreground/40 hover:text-foreground",
  );
}

interface ProjectTabsProps {
  projectId: string;
}

export function ProjectTabs({ projectId }: ProjectTabsProps) {
  const pathname = usePathname() ?? "";
  const { user } = useAuth();
  const canManageSkills = user?.permissions.includes("project.update") ?? false;
  const base = `/projects/${projectId}`;
  const model = getProjectTabModel(projectId, { canManageSkills });

  const overflowActive = model.overflow.some((t) => isProjectTabActive(pathname, t.href, base));

  // R1 (#156): on viewports below `md` the whole bar collapses into a single
  // dropdown showing the current section, eliminating horizontal scrolling.
  const allLinks = flattenProjectTabs(model);
  const current = allLinks.find((l) => isProjectTabActive(pathname, l.href, base));
  const currentLabel = current?.label ?? "Overview";

  return (
    <nav
      aria-label="Project sections"
      className="border-b border-border"
      data-testid="project-tabs"
    >
      {/* Mobile: single dropdown (no horizontal scroll). */}
      <div className="px-4 py-2 md:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label="Project section menu"
            data-testid="project-tabs-mobile"
            className="flex w-full items-center justify-between gap-2 rounded-md border border-input bg-background px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="truncate">{currentLabel}</span>
            <ChevronDown className="h-4 w-4 shrink-0" aria-hidden />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="max-h-[60vh] w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
          >
            {allLinks.map((item) => {
              const itemActive = isProjectTabActive(pathname, item.href, base);
              return (
                <DropdownMenuItem key={item.href} asChild>
                  <Link href={item.href} aria-current={itemActive ? "page" : undefined}>
                    {item.label}
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Desktop: primary tabs + overflow. */}
      <div className="hidden items-stretch gap-1 px-6 md:flex">
        {model.primary.map((tab) => {
          if (tab.kind === "link") {
            const active = isProjectTabActive(pathname, tab.href, base);
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={tabClass(active)}
                aria-current={active ? "page" : undefined}
              >
                {tab.label}
              </Link>
            );
          }
          const active = tab.items.some((i) => isProjectTabActive(pathname, i.href, base));
          return (
            <DropdownMenu key={tab.label}>
              <DropdownMenuTrigger
                className={tabClass(active)}
                aria-current={active ? "page" : undefined}
                data-testid={`project-tab-group-${tab.label.toLowerCase()}`}
              >
                {tab.label}
                <ChevronDown className="h-3.5 w-3.5" aria-hidden />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {tab.items.map((item) => {
                  const itemActive = isProjectTabActive(pathname, item.href, base);
                  return (
                    <DropdownMenuItem key={item.href} asChild>
                      <Link href={item.href} aria-current={itemActive ? "page" : undefined}>
                        {item.label}
                      </Link>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })}

        <DropdownMenu>
          <DropdownMenuTrigger
            className={tabClass(overflowActive)}
            aria-current={overflowActive ? "page" : undefined}
            aria-label="More project sections"
            data-testid="project-tabs-more"
          >
            <MoreHorizontal className="h-4 w-4" aria-hidden />
            <span>More</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {model.overflow.map((item) => {
              const itemActive = isProjectTabActive(pathname, item.href, base);
              return (
                <DropdownMenuItem key={item.href} asChild>
                  <Link href={item.href} aria-current={itemActive ? "page" : undefined}>
                    {item.label}
                  </Link>
                </DropdownMenuItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </nav>
  );
}
