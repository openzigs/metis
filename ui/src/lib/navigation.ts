/**
 * Static navigation registry for the authenticated app shell. Single source of
 * truth for the sidebar, the route-active highlight, and middleware checks.
 */
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  CalendarClock,
  ClipboardCheck,
  Clock,
  Database,
  FileText,
  FolderKanban,
  Gauge,
  GitBranch,
  History,
  KeyRound,
  Layers,
  LayoutDashboard,
  ListChecks,
  MessageSquare,
  PanelsTopLeft,
  Radar,
  Settings,
  ShieldCheck,
  Sparkles,
  Wrench,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

/** A labeled group of sidebar items. The label is a non-interactive heading. */
export interface NavSection {
  /** Human-readable section heading rendered above the group. */
  label: string;
  /** Stable id used for `aria-labelledby` wiring. */
  id: string;
  items: readonly NavItem[];
}

/**
 * Grouped navigation registry (N1 / #140). Items are organised into four
 * labeled sections to improve scannability and information scent. `NAV_ITEMS`
 * is derived from this so existing consumers (middleware, route-active checks)
 * keep working without change.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: "work",
    label: "Work",
    items: [
      { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
      { href: "/projects", label: "Projects", icon: FolderKanban },
      { href: "/products", label: "Products", icon: Layers },
      { href: "/chat", label: "Chat", icon: MessageSquare },
      { href: "/workbench", label: "Workbench", icon: Wrench },
      { href: "/tasks", label: "Tasks", icon: ListChecks },
      { href: "/reviews", label: "Reviews", icon: ClipboardCheck },
    ],
  },
  {
    id: "knowledge",
    label: "Knowledge",
    items: [
      { href: "/library", label: "Library", icon: PanelsTopLeft },
      { href: "/documents", label: "Documents", icon: FileText },
      { href: "/repositories", label: "Repositories", icon: GitBranch },
      { href: "/databases", label: "Databases", icon: Database },
      { href: "/impact-analyses", label: "Impact Analysis", icon: Radar },
    ],
  },
  {
    id: "automation",
    label: "Automation",
    items: [
      { href: "/skills", label: "Skills", icon: Sparkles },
      { href: "/agents", label: "Agents", icon: Bot },
      { href: "/scheduler", label: "Scheduler", icon: CalendarClock },
      { href: "/runs", label: "Runs", icon: History },
      { href: "/sessions", label: "Sessions", icon: Clock },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    items: [
      { href: "/vault", label: "Vault", icon: KeyRound },
      { href: "/eval/leaderboard", label: "Eval", icon: Gauge },
      { href: "/settings", label: "Settings", icon: Settings },
      { href: "/admin", label: "Admin", icon: ShieldCheck },
    ],
  },
] as const;

/**
 * Flat list of every sidebar route, derived from {@link NAV_SECTIONS}. Single
 * source of truth for middleware checks and the route-active highlight.
 */
export const NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);

export const PUBLIC_PATHS: readonly string[] = ["/login"];

/**
 * True if `pathname` falls under any sidebar route — used by the active-link
 * indicator. Exact match or parent-segment match (e.g. /projects/123).
 */
export function isActiveRoute(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  return pathname.startsWith(href + "/");
}
