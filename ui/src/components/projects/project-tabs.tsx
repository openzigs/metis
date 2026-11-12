"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronDown, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/** A single navigable destination. */
export interface ProjectTabLink {
  href: string;
  label: string;
}

export type ProjectSectionId =
  "overview" | "knowledge" | "change-requests" | "requirements" | "deliverables" | "settings";

/** One primary tab: a stage of the analyst's job and the pages that belong to it. */
export interface ProjectSection {
  id: ProjectSectionId;
  label: string;
  /** Where the primary tab lands — the section's first step. */
  href: string;
  /** The section's pages, shown in the sub-nav. Empty for a one-page section. */
  items: ProjectTabLink[];
  /**
   * Routes that belong to this section but are reached from inside a page
   * rather than from the sub-nav (e.g. issue sync, the `/repositories`
   * redirect). Listed so
   * the tab still lights up there.
   */
  routes?: string[];
}

export interface ProjectTabModel {
  sections: ProjectSection[];
}

/**
 * #2334 (epic #2328) — the project tabs follow the analyst's job, not the
 * system: Overview · Knowledge · Change requests · Requirements · Deliverables · ⚙.
 *
 * This partly reverses #28, which made Code a peer tab: Code Overview, Pull
 * Requests and Spec Kit are not where an analyst works, so they sit behind ⚙
 * with the project's settings. Change Analysis (`/changes`) compares the
 * requirements of two analysis runs; its label is "Compare analyses" so it
 * cannot be read as the "Change requests" tab.
 *
 * Every primary tab is a direct link to its section's first step, so nothing on
 * the primary path is more than one click from the tab bar; a section's other
 * pages sit in a visible sub-nav under the bar. There is no "More" overflow.
 * No project route moved, so every existing URL still works.
 *
 * Skills are not linked from here — the per-project skill allowlist is reached
 * from Library, which has a project picker (#28).
 */
export function getProjectTabModel(projectId: string): ProjectTabModel {
  const base = `/projects/${projectId}`;
  return {
    sections: [
      { id: "overview", label: "Overview", href: base, items: [] },
      {
        id: "knowledge",
        label: "Knowledge",
        href: `${base}/connections`,
        items: [
          { href: `${base}/connections`, label: "Connections" },
          { href: `${base}/documents`, label: "Documents" },
        ],
        // #1371 — `/repositories` redirects to Connections; old links still
        // land there.
        routes: [`${base}/repositories`],
      },
      {
        id: "change-requests",
        label: "Change requests",
        href: `${base}/analysis`,
        items: [
          { href: `${base}/analysis`, label: "Requirements Analysis" },
          // Intake: requirements brought in from another system.
          { href: `${base}/import`, label: "Import" },
          { href: `${base}/jira`, label: "Jira" },
          { href: `${base}/impact`, label: "Impact Analysis" },
        ],
      },
      {
        id: "requirements",
        label: "Requirements",
        href: `${base}/requirements`,
        items: [
          { href: `${base}/requirements`, label: "Review" },
          { href: `${base}/baselines`, label: "Baselines" },
          { href: `${base}/discussions`, label: "Discussions" },
          { href: `${base}/changes`, label: "Compare analyses" },
        ],
      },
      {
        id: "deliverables",
        label: "Deliverables",
        href: `${base}/documentation`,
        items: [
          { href: `${base}/documentation`, label: "Documentation" },
          { href: `${base}/settings/templates`, label: "Templates" },
          { href: `${base}/publish`, label: "Publish" },
        ],
        // Issue-sync drift dashboard — reached from published issues' badges.
        routes: [`${base}/sync`],
      },
      {
        id: "settings",
        label: "Project settings",
        href: `${base}/settings`,
        items: [
          { href: `${base}/settings`, label: "General" },
          { href: `${base}/settings/models`, label: "Models" },
          { href: `${base}/plugins`, label: "Plugins" },
          // #31 — usage has one home; this is its Project scope for this project.
          {
            href: `/settings/usage?scope=project&projectId=${encodeURIComponent(projectId)}`,
            label: "Usage",
          },
          // #2334 — code views are not an analyst's daily work; they sit here.
          { href: `${base}/overview`, label: "Code Overview" },
          { href: `${base}/pulls`, label: "Pull Requests" },
          { href: `${base}/spec-kit`, label: "Spec Kit" },
        ],
      },
    ],
  };
}

/** The links a section contributes to a flat list: its pages, or itself. */
function sectionLinks(section: ProjectSection): ProjectTabLink[] {
  return section.items.length > 0 ? section.items : [{ href: section.href, label: section.label }];
}

/** Every destination, once — for reachability checks and the mobile menu. */
export function flattenProjectTabs(model: ProjectTabModel): ProjectTabLink[] {
  return model.sections.flatMap(sectionLinks);
}

/** Active when the link is the project index (exact) or a section prefix. */
export function isProjectTabActive(pathname: string, href: string, projectBase: string): boolean {
  if (href === projectBase) return pathname === projectBase;
  return pathname === href || pathname.startsWith(href + "/");
}

export interface ActiveProjectTab {
  section: ProjectSection;
  /** The sub-nav page that matched, or null for a route outside the sub-nav. */
  item: ProjectTabLink | null;
}

/**
 * Resolve which section (and sub-nav page) a pathname belongs to. The longest
 * matching href wins, which is what puts `/settings/templates` under Deliverables
 * rather than under ⚙'s `/settings`. The project index matches only exactly.
 */
export function resolveActiveProjectTab(
  pathname: string,
  model: ProjectTabModel,
): ActiveProjectTab | null {
  const overview = model.sections[0];
  const base = overview.href;
  const path = pathname.replace(/\/+$/, "");
  if (path === base) return { section: overview, item: null };

  let best: ActiveProjectTab | null = null;
  let bestLength = -1;
  for (const section of model.sections.slice(1)) {
    const candidates: Array<[string, ProjectTabLink | null]> = [
      ...section.items.map((item): [string, ProjectTabLink] => [item.href, item]),
      [section.href, null],
      ...(section.routes ?? []).map((route): [string, null] => [route, null]),
    ];
    for (const [href, item] of candidates) {
      if (href.length > bestLength && isProjectTabActive(path, href, base)) {
        best = { section, item };
        bestLength = href.length;
      }
    }
  }
  return best;
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

function subTabClass(active: boolean): string {
  return cn(
    "inline-flex items-center whitespace-nowrap rounded-md px-2.5 py-1 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active
      ? "bg-muted font-medium text-foreground"
      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
  );
}

interface ProjectTabsProps {
  projectId: string;
}

export function ProjectTabs({ projectId }: ProjectTabsProps) {
  const pathname = usePathname() ?? "";
  const model = getProjectTabModel(projectId);
  const active = resolveActiveProjectTab(pathname, model);
  // The page showing, as a link href. A route outside the sub-nav (issue sync)
  // is none of the section's links, so it marks none of them "page" (#2334:
  // Deliverables' sub-nav is visible there, and Documentation is not the page).
  const activeHref = !active
    ? null
    : (active.item?.href ?? (active.section.items.length === 0 ? active.section.href : null));
  // The current page's own label; a route outside the sub-nav shows its section.
  const currentLabel = active ? (active.item?.label ?? active.section.label) : "Overview";
  const subnavSection = active && active.section.items.length > 1 ? active.section : null;

  return (
    <div className="border-b border-border">
      <nav aria-label="Project sections" data-testid="project-tabs">
        {/* R1 (#156): below `md` the bar collapses into one dropdown. */}
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
              {model.sections.map((section) => (
                <DropdownMenuGroup key={section.id}>
                  {section.items.length > 0 ? (
                    <DropdownMenuLabel className="text-xs text-muted-foreground">
                      {section.label}
                    </DropdownMenuLabel>
                  ) : null}
                  {sectionLinks(section).map((item) => (
                    <DropdownMenuItem key={item.href} asChild>
                      <Link
                        href={item.href}
                        aria-current={item.href === activeHref ? "page" : undefined}
                      >
                        {item.label}
                      </Link>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuGroup>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Desktop: one link per pipeline stage. */}
        <ul className="hidden items-stretch gap-1 px-6 md:flex">
          {model.sections.map((section) => {
            const isActive = active?.section.id === section.id;
            // "page" when this tab's own landing page is showing; "true" when
            // another page of the section is (the current item within the set).
            const current = !isActive ? undefined : activeHref === section.href ? "page" : "true";
            const isGear = section.id === "settings";
            return (
              <li key={section.id} className="flex">
                <Link
                  href={section.href}
                  className={tabClass(isActive)}
                  aria-current={current}
                  data-testid={`project-tab-${section.id}`}
                  // ⚙ is a glyph: its name is text for assistive tech, and a tooltip for sight.
                  title={isGear ? section.label : undefined}
                >
                  {isGear ? (
                    <>
                      <Settings className="h-4 w-4" aria-hidden />
                      <span className="sr-only">{section.label}</span>
                    </>
                  ) : (
                    section.label
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      {subnavSection ? (
        <nav
          aria-label={`${subnavSection.label} pages`}
          data-testid="project-subnav"
          className="hidden flex-wrap gap-1 px-6 py-2 md:flex"
        >
          {subnavSection.items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={subTabClass(item.href === activeHref)}
              aria-current={item.href === activeHref ? "page" : undefined}
            >
              {item.label}
            </Link>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
