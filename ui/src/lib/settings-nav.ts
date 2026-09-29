/**
 * N6 (#154) — Settings sub-navigation registry. Single source of truth for the
 * persistent settings nav rendered by `settings/layout.tsx`.
 *
 * #31 — Settings and Admin are one area. The former Admin pages are sections
 * here marked `adminOnly`: hidden from the nav, and refused by the layout, for
 * anyone who is not a system admin. The server still enforces every write.
 */
export interface SettingsNavItem {
  href: string;
  label: string;
  /** Shown to, and rendered for, system admins only. */
  adminOnly?: boolean;
}

export const SETTINGS_NAV: readonly SettingsNavItem[] = [
  { href: "/settings", label: "Overview" },
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/appearance", label: "Appearance" },
  { href: "/settings/notifications", label: "Notifications" },
  { href: "/settings/api-keys", label: "Configuration" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/mcp", label: "MCP servers" },
  { href: "/settings/usage", label: "Usage & cost" },
  { href: "/settings/acp", label: "ACP tokens" },
  { href: "/settings/hooks", label: "Hooks" },
  { href: "/settings/triggers", label: "Triggers" },
  { href: "/settings/workspaces", label: "Workspaces", adminOnly: true },
  { href: "/settings/auth", label: "SSO & authentication", adminOnly: true },
  { href: "/settings/embeddings", label: "Embeddings", adminOnly: true },
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
