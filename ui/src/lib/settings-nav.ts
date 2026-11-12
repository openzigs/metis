/**
 * N6 (#154) — Settings sub-navigation registry. Single source of truth for the
 * persistent settings nav rendered by `settings/layout.tsx`.
 *
 * #31 — Settings and Admin are one area. The former Admin pages are sections
 * here marked `adminOnly`: hidden from the nav, and refused by the layout, for
 * anyone who is not a system admin. The server still enforces every write.
 *
 * Workspaces is deliberately NOT admin-only: any signed-in user may create one
 * and becomes its owner, and every other workspace action is gated on the
 * workspace membership role (`requireWorkspaceRole`), not the system role.
 */
export interface SettingsNavItem {
  href: string;
  label: string;
  /** Shown to, and rendered for, system admins only. */
  adminOnly?: boolean;
  /**
   * Listed under the "Administration" heading. #2332 — kept apart from
   * `adminOnly` so hiding the developer sections from non-admins leaves an
   * admin's nav in the order it had.
   */
  administration?: boolean;
}

export const SETTINGS_NAV: readonly SettingsNavItem[] = [
  { href: "/settings", label: "Overview" },
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/appearance", label: "Appearance" },
  { href: "/settings/notifications", label: "Notifications" },
  // #2332 — Configuration, MCP servers, ACP tokens, Hooks and Triggers are
  // developer and operations tools, not part of an analyst's job.
  { href: "/settings/api-keys", label: "Configuration", adminOnly: true },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/mcp", label: "MCP servers", adminOnly: true },
  { href: "/settings/usage", label: "Usage & cost" },
  { href: "/settings/acp", label: "ACP tokens", adminOnly: true },
  { href: "/settings/hooks", label: "Hooks", adminOnly: true },
  { href: "/settings/triggers", label: "Triggers", adminOnly: true },
  { href: "/settings/workspaces", label: "Workspaces" },
  {
    href: "/settings/auth",
    label: "SSO & authentication",
    adminOnly: true,
    administration: true,
  },
  { href: "/settings/embeddings", label: "Embeddings", adminOnly: true, administration: true },
] as const;

/**
 * True if `pathname` is within `href`. The settings index (`/settings`) matches
 * only exactly so it isn't highlighted on every sub-page.
 */
export function isSettingsNavActive(pathname: string, href: string): boolean {
  if (href === "/settings") return pathname === "/settings";
  return pathname === href || pathname.startsWith(href + "/");
}

/** The settings sections this user may see. */
export function visibleSettingsNav(isAdmin: boolean): SettingsNavItem[] {
  return SETTINGS_NAV.filter((item) => isAdmin || !item.adminOnly);
}

/** True if `pathname` is inside an admin-only settings section. */
export function isAdminOnlySettingsPath(pathname: string): boolean {
  return SETTINGS_NAV.some((item) => item.adminOnly && isSettingsNavActive(pathname, item.href));
}
