/**
 * Static navigation registry for the authenticated app shell. Single source of
 * truth for the sidebar, the hub tab bar, the route-active highlight, the
 * command palette and the page breadcrumb.
 *
 * #27 — the sidebar lists six object-level destinations. Each one is a *hub*
 * whose `tabs` are the pages it absorbed; the pages keep their URLs, so every
 * bookmark and deep link still resolves, and the hub tab bar
 * (`components/layout/hub-tabs`) is what makes the sibling pages reachable.
 */
import type { LucideIcon } from "lucide-react";
import { isAdminOnlySettingsPath } from "@/lib/settings-nav";
import {
  Activity,
  FolderKanban,
  House,
  MessageSquare,
  PanelsTopLeft,
  Settings,
} from "lucide-react";

/** One page inside a hub, rendered as a tab in the hub tab bar. */
export interface NavTab {
  href: string;
  label: string;
  /** Active only on `href` itself, not below it — `/projects/<id>` has its own tabs. */
  exact?: boolean;
  /** Prefix that marks the tab active when it differs from `href` (e.g. `/eval`). */
  match?: string;
  /** Shown only to system admins. */
  adminOnly?: boolean;
}

/** A top-level sidebar destination. */
export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** The pages this destination absorbs; the first is its landing page. */
  tabs: readonly NavTab[];
}

export const NAV_ITEMS: readonly NavItem[] = [
  {
    href: "/dashboard",
    label: "Home",
    icon: House,
    tabs: [{ href: "/dashboard", label: "Dashboard" }],
  },
  {
    href: "/projects",
    label: "Projects",
    icon: FolderKanban,
    tabs: [
      { href: "/projects", label: "All projects", exact: true },
      { href: "/products", label: "Products" },
      { href: "/documents", label: "Documents" },
      { href: "/repositories", label: "Repositories" },
      { href: "/databases", label: "Databases" },
      { href: "/impact-analyses", label: "Impact analyses" },
    ],
  },
  {
    href: "/chat",
    label: "Chat",
    icon: MessageSquare,
    tabs: [
      { href: "/chat", label: "Chat" },
      { href: "/workbench", label: "Workbench" },
    ],
  },
  {
    href: "/tasks",
    label: "Activity",
    icon: Activity,
    tabs: [
      { href: "/tasks", label: "Tasks" },
      { href: "/runs", label: "Runs" },
      { href: "/sessions", label: "Sessions" },
      { href: "/scheduler", label: "Scheduler" },
      { href: "/reviews", label: "Reviews" },
    ],
  },
  {
    href: "/library",
    label: "Library",
    icon: PanelsTopLeft,
    tabs: [{ href: "/library", label: "Library" }],
  },
  {
    href: "/settings",
    label: "Settings",
    icon: Settings,
    tabs: [
      { href: "/settings", label: "Settings" },
      { href: "/vault", label: "Vault" },
      { href: "/eval/leaderboard", label: "Eval", match: "/eval" },
    ],
  },
];

/** Every page reachable from the sidebar, flattened — for search and breadcrumbs. */
export const NAV_DESTINATIONS: readonly NavTab[] = NAV_ITEMS.flatMap((i) => i.tabs);

/**
 * What the ⌘K palette searches: every sidebar page, plus each concept's one
 * home (#31) — Skills and Agents in the Library, MCP servers and usage in
 * Settings.
 */
export const PALETTE_DESTINATIONS: readonly NavTab[] = [
  ...NAV_DESTINATIONS,
  { href: "/library?tab=skills", label: "Skills" },
  { href: "/library?tab=agents", label: "Agents" },
  { href: "/settings/mcp", label: "MCP servers" },
  { href: "/settings/usage", label: "Usage & cost" },
];

/**
 * #368 — the palette entries this user may see. Hides an entry marked
 * `adminOnly` and any admin-only Settings section (`settings-nav`) from a
 * non-admin, the same rule the hub tabs (`visibleTabs`) and the Settings nav
 * apply, so the palette cannot list a page the rest of the shell hides.
 */
export function paletteDestinations(
  isAdmin: boolean,
  destinations: readonly NavTab[] = PALETTE_DESTINATIONS,
): NavTab[] {
  if (isAdmin) return [...destinations];
  return destinations.filter((t) => !t.adminOnly && !isAdminOnlySettingsPath(t.href));
}

export const PUBLIC_PATHS: readonly string[] = ["/login"];

/**
 * True if `pathname` falls under `href`. Exact match or parent-segment match
 * (e.g. /projects/123).
 */
export function isActiveRoute(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  return pathname.startsWith(href + "/");
}

export function isTabActive(pathname: string, tab: NavTab): boolean {
  if (tab.exact) return pathname === tab.href;
  return isActiveRoute(pathname, tab.match ?? tab.href);
}

/** A sidebar entry is active on its own subtree and on any of its tabs. */
export function isNavItemActive(pathname: string, item: NavItem): boolean {
  return isActiveRoute(pathname, item.href) || item.tabs.some((t) => isTabActive(pathname, t));
}

/**
 * The sidebar entry's `aria-current`. `"page"` only for a single-page hub
 * (Home, Library), where no tab bar names the page; elsewhere a hub tab or the
 * project's own tabs carry `"page"`, so the entry marks the location (`"true"`).
 */
export function navItemCurrent(pathname: string, item: NavItem): "page" | "true" | undefined {
  if (!isNavItemActive(pathname, item)) return undefined;
  return item.tabs.length === 1 && pathname === item.href ? "page" : "true";
}

/** The tabs of `item` this user may see. */
export function visibleTabs(item: NavItem, isAdmin: boolean): NavTab[] {
  return item.tabs.filter((t) => isAdmin || !t.adminOnly);
}

/** The hub whose tab bar belongs on `pathname`, if any tab of it is active. */
export function hubForPath(pathname: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.tabs.some((t) => isTabActive(pathname, t)));
}
