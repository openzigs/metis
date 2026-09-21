"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { NAV_SECTIONS, isActiveRoute } from "@/lib/navigation";

interface SidebarProps {
  /** Controls visibility on small viewports — the parent shell owns this state. */
  mobileOpen: boolean;
  onMobileClose: () => void;
}

interface NavListProps {
  pathname: string;
  onNavigate?: () => void;
}

function NavList({ pathname, onNavigate }: NavListProps) {
  return (
    <nav aria-label="Sections" className="flex-1 space-y-4 overflow-y-auto p-2">
      {NAV_SECTIONS.map((section) => {
        const headingId = `nav-section-${section.id}`;
        return (
          <div key={section.id} className="space-y-1">
            <h2
              id={headingId}
              className="px-3 pt-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {section.label}
            </h2>
            <ul aria-labelledby={headingId} className="space-y-1">
              {section.items.map((item) => {
                const active = isActiveRoute(pathname, item.href);
                const Icon = item.icon;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      data-active={active}
                      className={cn(
                        "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "bg-accent text-accent-foreground"
                          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden />
                      <span>{item.label}</span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/dashboard"
      className="flex items-center gap-2 font-bold tracking-tight"
      onClick={onNavigate}
    >
      <Image
        src="/icon.svg"
        alt=""
        width={32}
        height={32}
        className="h-8 w-8 rounded-md"
        aria-hidden
        priority
      />
      <span>METIS</span>
    </Link>
  );
}

/**
 * Persistent sidebar for the authed shell. The persistent column renders only
 * on `md+` viewports. On smaller viewports it is hidden entirely; the mobile
 * drawer is rendered separately via Radix Dialog (Sheet) which gives us a
 * proper modal dialog with focus trap, ESC-to-close, return-focus to opener,
 * and an inert/aria-hidden tree when closed — i.e. nothing is tabbable in the
 * drawer when it's shut.
 */
export function Sidebar({ mobileOpen, onMobileClose }: SidebarProps) {
  const pathname = usePathname() ?? "/";

  return (
    <>
      {/* Persistent sidebar — desktop only. */}
      <aside
        data-testid="sidebar"
        aria-label="Primary navigation"
        className="fixed inset-y-0 left-0 z-40 hidden h-screen w-64 flex-col border-r bg-card md:flex"
      >
        <div className="flex h-16 items-center border-b px-4">
          <Brand />
        </div>
        <NavList pathname={pathname} />
      </aside>

      {/* Mobile drawer — fully a11y-correct modal via Radix Dialog. */}
      <Sheet
        open={mobileOpen}
        onOpenChange={(open) => {
          if (!open) onMobileClose();
        }}
      >
        <SheetContent
          side="left"
          className="flex w-64 flex-col p-0 md:hidden"
          data-testid="sidebar-drawer"
          aria-label="Primary navigation"
        >
          <SheetTitle className="sr-only">Primary navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Application sections — use Tab to move through links, Escape to close.
          </SheetDescription>
          <div className="flex h-16 items-center border-b px-4">
            <Brand onNavigate={onMobileClose} />
          </div>
          <NavList pathname={pathname} onNavigate={onMobileClose} />
        </SheetContent>
      </Sheet>
    </>
  );
}
