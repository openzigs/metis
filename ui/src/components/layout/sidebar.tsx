"use client";

import Image from "next/image";
import Link from "next/link";
import { useId, useState } from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useAuth } from "@/lib/auth-context";
import { useAssignedReviewCount } from "@/hooks/use-assigned-review-count";
import { type NavItem, isNavItemActive, navItemCurrent, visibleNavItems } from "@/lib/navigation";

interface SidebarProps {
  /** Controls visibility on small viewports — the parent shell owns this state. */
  mobileOpen: boolean;
  onMobileClose: () => void;
}

interface NavListProps {
  items: readonly NavItem[];
  pathname: string;
  /** #2332 — reviews waiting on this user; `undefined` until known. */
  reviewCount: number | undefined;
  onNavigate?: () => void;
}

/** #2332 — the Reviews count as a sentence, for screen readers. */
export function assignedReviewsText(count: number): string {
  if (count === 0) return "No reviews assigned to you";
  return `${count} ${count === 1 ? "review" : "reviews"} assigned to you`;
}

/**
 * #2332 — what the live region says: the new count each time it changes after
 * it first loads. Not the first value, so a page load is not announced.
 * Adjusts state during render (React's pattern for deriving from a changed
 * value) rather than in an effect.
 */
function useCountAnnouncement(count: number | undefined): string {
  const [seen, setSeen] = useState<number | undefined>(undefined);
  const [message, setMessage] = useState("");
  if (count !== undefined && count !== seen) {
    if (seen !== undefined) setMessage(assignedReviewsText(count));
    setSeen(count);
  }
  return message;
}

function NavList({ items, pathname, reviewCount, onNavigate }: NavListProps) {
  // Two lists render (desktop column and drawer), so the description id is per list.
  const reviewsDescId = useId();
  // 0-safe: no badge for none, and none while unknown.
  const count = reviewCount ?? 0;
  return (
    <nav aria-label="Sections" className="flex-1 overflow-y-auto p-2">
      <ul className="space-y-1">
        {items.map((item) => {
          const active = isNavItemActive(pathname, item);
          const Icon = item.icon;
          const counted = item.href === "/reviews" && count > 0;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                onClick={onNavigate}
                aria-current={navItemCurrent(pathname, item)}
                aria-describedby={counted ? reviewsDescId : undefined}
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
                {counted ? (
                  <span
                    aria-hidden
                    data-testid="reviews-count"
                    className="ml-auto rounded-full bg-primary px-2 py-0.5 text-xs font-semibold leading-none text-primary-foreground"
                  >
                    {count > 99 ? "99+" : count}
                  </span>
                ) : null}
              </Link>
              {/* Outside the link, so it describes the entry without renaming it. */}
              {counted ? (
                <span id={reviewsDescId} className="sr-only">
                  {assignedReviewsText(count)}
                </span>
              ) : null}
            </li>
          );
        })}
      </ul>
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
  const { user } = useAuth();
  // #2332 — a non-admin sees no operations page; an admin sees NAV_ITEMS as is.
  const items = visibleNavItems(user?.role === "admin");
  const reviewCount = useAssignedReviewCount();
  const announcement = useCountAnnouncement(reviewCount);

  return (
    <>
      {/*
       * #2332 — announces a change in the Reviews count. One region for both
       * lists, outside the desktop column, which is display:none on a narrow
       * viewport and would silence it. A live region without `role="status"`:
       * it is on every page, and a page's own status message must stay the
       * only `status` there.
       */}
      <p
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
        data-testid="reviews-count-status"
      >
        {announcement}
      </p>
      {/* Persistent sidebar — desktop only. */}
      <aside
        data-testid="sidebar"
        aria-label="Primary navigation"
        className="fixed inset-y-0 left-0 z-40 hidden h-screen w-64 flex-col border-r bg-card md:flex"
      >
        <div className="flex h-16 items-center border-b px-4">
          <Brand />
        </div>
        <NavList items={items} pathname={pathname} reviewCount={reviewCount} />
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
          <NavList
            items={items}
            pathname={pathname}
            reviewCount={reviewCount}
            onNavigate={onMobileClose}
          />
        </SheetContent>
      </Sheet>
    </>
  );
}
