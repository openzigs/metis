/**
 * N6 (#154) — Settings sub-navigation registry. Single source of truth for the
 * persistent settings nav rendered by `settings/layout.tsx`.
 */
export interface SettingsNavItem {
  href: string;
  label: string;
}

export const SETTINGS_NAV: readonly SettingsNavItem[] = [
  { href: "/settings", label: "Overview" },
  { href: "/settings/profile", label: "Profile" },
  { href: "/settings/appearance", label: "Appearance" },
  { href: "/settings/notifications", label: "Notifications" },
  { href: "/settings/api-keys", label: "Configuration" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/mcp", label: "MCP servers" },
  { href: "/settings/agents", label: "Custom agents" },
  { href: "/settings/acp", label: "ACP tokens" },
  { href: "/settings/hooks", label: "Hooks" },
  { href: "/settings/triggers", label: "Triggers" },
] as const;

/**
 * True if `pathname` is within `href`. The settings index (`/settings`) matches
 * only exactly so it isn't highlighted on every sub-page.
 */
export function isSettingsNavActive(pathname: string, href: string): boolean {
  if (href === "/settings") return pathname === "/settings";
  return pathname === href || pathname.startsWith(href + "/");
}
