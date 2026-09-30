"use client";

import { Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "./theme-toggle";
import { HelpMenu } from "./help-menu";
import { Breadcrumbs } from "./breadcrumbs";
import { UserMenu } from "./user-menu";
import { NotificationsDrawer } from "@/components/notifications/notifications-drawer";
import { ActiveJobsIndicator } from "@/components/realtime/active-jobs-indicator";

interface HeaderProps {
  onMenuClick: () => void;
}

export function Header({ onMenuClick }: HeaderProps) {
  return (
    // #529 — below `sm` the header wraps: the breadcrumb takes a full-width
    // second row (see Breadcrumbs), because one row left it ~100px at 390px.
    <header
      role="banner"
      className="sticky top-0 z-20 flex min-h-16 flex-wrap items-center gap-x-3 gap-y-1 border-b bg-background/80 px-4 py-2 backdrop-blur supports-[backdrop-filter]:bg-background/60 sm:h-16 sm:flex-nowrap sm:py-0"
    >
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onMenuClick}
        aria-label="Open navigation"
      >
        <Menu className="h-4 w-4" />
      </Button>
      <Breadcrumbs />
      <div className="ml-auto flex items-center gap-2">
        {/* #420 — global "N jobs running" indicator; self-hides when idle. */}
        <ActiveJobsIndicator />
        <NotificationsDrawer />
        <ThemeToggle />
        {/* #661 — persistent Help affordance (WCAG 2.2 SC 3.2.6). Its fixed
            relative position between the theme toggle and the user menu, on
            every authed route, is what satisfies Consistent Help. */}
        <HelpMenu />
        <UserMenu />
      </div>
    </header>
  );
}
