"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { SETTINGS_NAV, isSettingsNavActive } from "@/lib/settings-nav";

/**
 * N6 (#154) — nested settings layout. Renders a persistent sub-navigation
 * alongside the active settings page so users keep context while moving between
 * sub-sections. Padding is owned by the shell `main` (R2 #157) — this layout
 * adds none of its own outer gutter.
 */
export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/settings";

  return (
    <div className="flex flex-col gap-6 md:flex-row" data-testid="settings-layout">
      <nav aria-label="Settings" className="md:w-56 md:shrink-0">
        <ul className="flex gap-1 overflow-x-auto pb-1 md:flex-col md:overflow-visible md:pb-0">
          {SETTINGS_NAV.map((item) => {
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
      </nav>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
