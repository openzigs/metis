"use client";

import Link from "next/link";
import { BookOpen, HelpCircle, LifeBuoy, Keyboard } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

/**
 * Persistent Help affordance (Issue #661 — WCAG 2.2 SC 3.2.6 Consistent Help, AA).
 *
 * Rendered by the global {@link Header} in an identical relative location on
 * every authenticated route (immediately right of the theme toggle), which is
 * what moves 3.2.6 from *Not Applicable* → *Supports* in the VPAT.
 *
 * The trigger is an icon-only button with an explicit accessible name ("Help")
 * and is keyboard-operable. It opens the app's shared Radix Dialog primitive —
 * the same one used elsewhere — so it inherits the focus trap, Escape-to-close
 * and focus-restore behaviour for free.
 *
 * The dialog exposes SC 3.2.6-allowed help mechanisms: a self-help /
 * documentation link and a contact mechanism. #2337 — both open the in-app Help
 * page (`/help`), not GitHub: an analyst may have no access to the repository,
 * and the person to contact is the deployment's own administrator.
 */

interface HelpLink {
  href: string;
  label: string;
  description: string;
  icon: typeof HelpCircle;
}

const HELP_LINKS: HelpLink[] = [
  {
    href: "/help",
    label: "User guide & documentation",
    description: "How to get started, where things are in a project, and what METIS's words mean.",
    icon: BookOpen,
  },
  {
    href: "/help#contact",
    label: "Contact support — ask your administrator",
    description: "Who to ask for access, vault secrets and AI settings.",
    icon: LifeBuoy,
  },
];

export function HelpMenu() {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Help"
          data-testid="help-trigger"
          className="h-9 w-9"
        >
          <HelpCircle className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Help &amp; support</DialogTitle>
          <DialogDescription>
            Find your way around METIS, or reach out if you&apos;re stuck.
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {HELP_LINKS.map(({ href, label, description, icon: Icon }) => (
            <li key={href}>
              {/* Closing on navigation: the dialog would otherwise stay open over /help. */}
              <DialogClose asChild>
                <Link
                  href={href}
                  className="flex items-start gap-3 rounded-md border p-3 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Icon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="flex flex-col">
                    <span className="text-sm font-medium">{label}</span>
                    <span className="text-xs text-muted-foreground">{description}</span>
                  </span>
                </Link>
              </DialogClose>
            </li>
          ))}
        </ul>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Keyboard className="h-4 w-4 shrink-0" aria-hidden />
          Press <kbd className="rounded border px-1">Ctrl</kbd>/
          <kbd className="rounded border px-1">⌘</kbd> +{" "}
          <kbd className="rounded border px-1">K</kbd> to open the command palette.
        </p>
      </DialogContent>
    </Dialog>
  );
}
