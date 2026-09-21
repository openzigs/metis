/**
 * Epic #196 / #220 — Settings hub.
 *
 * The original monolithic Settings page (Phase 12, issue #87) has been
 * split into dedicated sub-pages. This file is now a navigation index that
 * cards every settings surface — including pre-existing sub-pages
 * (`/settings/{acp,agents,hooks,mcp,triggers}`) and the new sub-pages
 * (`/settings/{profile,appearance,notifications,api-keys}`).
 *
 * Server-rendered card grid; no client interactivity needed.
 */
import Link from "next/link";
import {
  Bell,
  Bot,
  Cable,
  KeyRound,
  Network,
  Palette,
  Plug,
  ServerCog,
  User as UserIcon,
  Wallet,
  Webhook,
} from "lucide-react";
import { Card } from "@/components/ui/card";

interface HubLink {
  href: string;
  title: string;
  description: string;
  icon: typeof UserIcon;
  testId: string;
}

const HUB_LINKS: HubLink[] = [
  {
    href: "/settings/profile",
    title: "Profile",
    description: "Username, display name, email, and assigned role.",
    icon: UserIcon,
    testId: "settings-hub-link-profile",
  },
  {
    href: "/settings/appearance",
    title: "Appearance",
    description: "Theme (light / dark / system) and UI density.",
    icon: Palette,
    testId: "settings-hub-link-appearance",
  },
  {
    href: "/settings/notifications",
    title: "Notifications",
    description: "Channel + event preferences for in-app, email, and webhooks.",
    icon: Bell,
    testId: "settings-hub-link-notifications",
  },
  {
    href: "/settings/api-keys",
    title: "Configuration",
    description: "Runtime secrets, tunables, bootstrap config, and audit log.",
    icon: KeyRound,
    testId: "settings-hub-link-api-keys",
  },
  {
    href: "/settings/integrations",
    title: "Integrations",
    description:
      "MCP servers, hooks, and triggers. Repositories, databases, and the vault live in the sidebar.",
    icon: Cable,
    testId: "settings-hub-link-integrations",
  },
  {
    href: "/settings/mcp",
    title: "MCP servers",
    description: "Connect, browse the registry, and import / export servers.",
    icon: Network,
    testId: "settings-hub-link-mcp",
  },
  {
    href: "/settings/agents",
    title: "Custom agents",
    description: "Manage org-wide custom agents and their tool grants.",
    icon: Bot,
    testId: "settings-hub-link-agents",
  },
  {
    href: "/settings/acp",
    title: "ACP tokens",
    description: "Issue and revoke Agent Client Protocol tokens.",
    icon: ServerCog,
    testId: "settings-hub-link-acp",
  },
  {
    href: "/settings/hooks",
    title: "Hooks",
    description: "Project hook templates and execution history.",
    icon: Plug,
    testId: "settings-hub-link-hooks",
  },
  {
    href: "/settings/triggers",
    title: "Triggers",
    description: "Webhook + cron triggers and their last firing details.",
    icon: Webhook,
    testId: "settings-hub-link-triggers",
  },
  {
    // FinOps is workspace-scoped (lives at /workspaces/:id/finops). The active
    // workspace id is only known client-side (localStorage), so this hub card —
    // a server component — links to the workspace list, from which each
    // workspace's FinOps surface is reachable.
    href: "/admin/workspaces",
    title: "FinOps",
    description: "Track and control workspace AI spend (cost & budget tracking).",
    icon: Wallet,
    testId: "settings-hub-link-finops",
  },
];

export default function SettingsHubPage() {
  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="settings-hub-root">
      <header>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Pick a category to view or edit. Sensitive credentials live in the dedicated{" "}
          <Link href="/vault" className="underline">
            Vault
          </Link>{" "}
          surface.
        </p>
      </header>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {HUB_LINKS.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            data-testid={link.testId}
            className="group focus:outline-none"
          >
            <Card className="flex h-full flex-col gap-2 p-4 transition group-hover:border-primary/60 group-focus-visible:border-primary">
              <div className="flex items-center gap-2">
                <link.icon
                  aria-hidden="true"
                  className="h-4 w-4 text-muted-foreground group-hover:text-foreground"
                />
                <h2 className="text-sm font-semibold">{link.title}</h2>
              </div>
              <p className="text-xs text-muted-foreground">{link.description}</p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
