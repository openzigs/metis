/**
 * Epic #196 / #220 — Settings hub.
 *
 * The original monolithic Settings page (Phase 12, issue #87) has been
 * split into dedicated sub-pages. This file is now a navigation index that
 * cards every settings surface — including pre-existing sub-pages
 * (`/settings/{acp,agents,hooks,mcp,triggers}`) and the new sub-pages
 * (`/settings/{profile,appearance,notifications,api-keys}`).
 *
 * #31 — Settings and Admin are one area: the former Admin sections are cards
 * here, shown to system admins only. Skills and agents have their one home in
 * the Library, and usage in Settings → Usage & cost; their cards link there.
 */
"use client";

import Link from "next/link";
import {
  Bell,
  BookOpen,
  Bot,
  Building2,
  Cable,
  Cpu,
  KeyRound,
  ShieldCheck,
  Network,
  Palette,
  Plug,
  ServerCog,
  User as UserIcon,
  Wallet,
  Webhook,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { useAuth } from "@/lib/auth-context";

interface HubLink {
  href: string;
  title: string;
  description: string;
  icon: typeof UserIcon;
  testId: string;
  adminOnly?: boolean;
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
      "MCP servers, hooks, and triggers. Repositories and databases live under Projects; the vault has its own tab above.",
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
    href: "/library?tab=skills",
    title: "Skills",
    description: "Author skills and choose which ones each project may use (in the Library).",
    icon: BookOpen,
    testId: "settings-hub-link-skills",
  },
  {
    href: "/library?tab=agents",
    title: "Agents",
    description: "Library agents and each project's custom agents (in the Library).",
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
    href: "/settings/usage",
    title: "Usage & cost",
    description: "Tokens and AI spend by project or workspace, with budgets and alerts (FinOps).",
    icon: Wallet,
    testId: "settings-hub-link-usage",
  },
  {
    href: "/settings/workspaces",
    title: "Workspaces",
    description: "Create and manage workspaces, members, and project assignments.",
    icon: Building2,
    testId: "settings-hub-link-workspaces",
    adminOnly: true,
  },
  {
    href: "/settings/auth",
    title: "SSO & authentication",
    description: "SAML, OIDC, SCIM, and group-to-role mappings.",
    icon: ShieldCheck,
    testId: "settings-hub-link-auth",
    adminOnly: true,
  },
  {
    href: "/settings/embeddings",
    title: "Embeddings",
    description: "Select the RAG embedding backend and reindex projects.",
    icon: Cpu,
    testId: "settings-hub-link-embeddings",
    adminOnly: true,
  },
];

export default function SettingsHubPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const links = HUB_LINKS.filter((link) => isAdmin || !link.adminOnly);
  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="settings-hub-root">
      <PageHeader
        title="Settings"
        description={
          <>
            Pick a category to view or edit. Sensitive credentials live in the dedicated{" "}
            <Link href="/vault" className="underline">
              Vault
            </Link>{" "}
            surface.
          </>
        }
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {links.map((link) => (
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
