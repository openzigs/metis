"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth-context";
import { hubForPath, isTabActive, visibleTabs } from "@/lib/navigation";

/**
 * #27 — the page tabs of the sidebar destination the user is in (Projects →
 * All projects / Products / Documents / …). Each tab is its own route, so this
 * is link navigation with `aria-current`, not an ARIA tablist. Renders nothing
 * outside a hub, and nothing for a hub with a single visible page.
 */
export function HubTabs() {
  const pathname = usePathname() ?? "/";
  const { user } = useAuth();
  const hub = hubForPath(pathname);
  if (!hub) return null;
  const tabs = visibleTabs(hub, user?.role === "admin");
  if (tabs.length < 2) return null;

  return (
    <nav aria-label={`${hub.label} pages`} data-testid="hub-tabs" className="mb-4 border-b md:mb-6">
      <ul className="-mb-px flex gap-1 overflow-x-auto">
        {tabs.map((tab) => {
          const active = isTabActive(pathname, tab);
          return (
            <li key={tab.href}>
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                data-active={active}
                className={cn(
                  "block whitespace-nowrap border-b-2 px-3 py-2 text-sm transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active
                    ? "border-primary font-medium text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
