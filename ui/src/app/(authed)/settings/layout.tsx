"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import {
  type SettingsNavItem,
  isAdminOnlySettingsPath,
  isSettingsNavActive,
  visibleSettingsNav,
} from "@/lib/settings-nav";

/**
 * N6 (#154) — nested settings layout. Renders a persistent sub-navigation
 * alongside the active settings page so users keep context while moving between
 * sub-sections. Padding is owned by the shell `main` (R2 #157) — this layout
 * adds none of its own outer gutter.
 *
 * #31 — Settings and Admin are one area: admin-only sections are listed under
 * "Administration" for system admins, and a non-admin who opens one gets a
 * notice instead of the page.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/settings";
  const { user, isLoading } = useAuth();
  const isAdmin = user?.role === "admin";
  const items = visibleSettingsNav(isAdmin);
  const general = items.filter((i) => !i.adminOnly);
  const admin = items.filter((i) => i.adminOnly);
  const refused = !isAdmin && !isLoading && isAdminOnlySettingsPath(pathname);

  return (
    <div className="flex flex-col gap-6 md:flex-row" data-testid="settings-layout">
      <nav aria-label="Settings" className="md:w-56 md:shrink-0">
        <NavList items={general} pathname={pathname} />
        {admin.length > 0 ? (
          <>
            <p
              className="mt-4 hidden px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground md:block"
              id="settings-nav-admin"
            >
              Administration
            </p>
            <NavList items={admin} pathname={pathname} labelledBy="settings-nav-admin" />
          </>
        ) : null}
      </nav>
      <div className="min-w-0 flex-1">
        {refused ? (
          <div role="alert" data-testid="settings-admin-required" className="text-sm">
            This section is for system administrators.
          </div>
        ) : isAdminOnlySettingsPath(pathname) && isLoading ? null : (
          children
        )}
      </div>
    </div>
  );
}

function NavList({
  items,
  pathname,
  labelledBy,
}: {
  items: SettingsNavItem[];
  pathname: string;
  labelledBy?: string;
}) {
  return (
    <ul
      aria-labelledby={labelledBy}
      className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0"
    >
      {items.map((item) => {
        const active = isSettingsNavActive(pathname, item.href);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={active ? "page" : undefined}
              data-active={active}
              className={cn(
                "block whitespace-nowrap rounded-md px-3 py-2 text-sm font-medium transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                active
                  ? "bg-accent text-accent-foreground"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
