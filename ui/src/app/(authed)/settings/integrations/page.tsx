/**
 * Epic #196 / #221 — Integrations sub-page.
 *
 * Per AC: surface third-party integrations that were "buried in project
 * pages" with connect / disconnect controls. Connectors are project-scoped,
 * so this page acts as a navigation index that points administrators at the
 * relevant per-project tabs and at the new top-level surfaces.
 *
 * No new server endpoints (per AC). Existing connector + MCP routes remain
 * the source of truth.
 */
import Link from "next/link";
import {
  Bell,
  Database,
  GitBranch,
  Network,
  Plug,
  Webhook,
  ShieldCheck,
  MessageSquare,
} from "lucide-react";
import { Card } from "@/components/ui/card";

interface IntegrationLink {
  href: string;
  title: string;
  description: string;
  icon: typeof Database;
  testId: string;
}

const INTEGRATIONS: IntegrationLink[] = [
  {
    href: "/repositories",
    title: "Code repositories",
    description: "GitHub / GitLab connectors across every accessible project.",
    icon: GitBranch,
    testId: "settings-integrations-link-repositories",
  },
  {
    href: "/databases",
    title: "Databases",
    description: "Postgres, MySQL, and SQLite connections for agent + RAG use.",
    icon: Database,
    testId: "settings-integrations-link-databases",
  },
  {
    href: "/settings/mcp",
    title: "MCP servers",
    description: "Connect, browse the registry, and import / export MCP servers.",
    icon: Network,
    testId: "settings-integrations-link-mcp",
  },
  {
    href: "/settings/hooks",
    title: "Hooks",
    description: "Project hook templates and last-fired execution history.",
    icon: Plug,
    testId: "settings-integrations-link-hooks",
  },
  {
    href: "/settings/triggers",
    title: "Triggers",
    description: "Webhook + cron triggers wired to scheduled jobs.",
    icon: Webhook,
    testId: "settings-integrations-link-triggers",
  },
  {
    href: "/settings/integrations/notifications",
    title: "Notifications",
    description: "Connect Slack + PagerDuty and route alert events to each channel.",
    icon: Bell,
    testId: "settings-integrations-link-notifications",
  },
  {
    href: "/settings/integrations/teams",
    title: "Microsoft Teams",
    description: "Connect a Teams bot to bridge discussions and notifications into channels.",
    icon: MessageSquare,
    testId: "settings-integrations-link-teams",
  },
  {
    href: "/vault",
    title: "Vault",
    description: "Manage the credentials these integrations rely on.",
    icon: ShieldCheck,
    testId: "settings-integrations-link-vault",
  },
];

export default function SettingsIntegrationsPage() {
  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="settings-integrations-root">
      <header>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Manage third-party systems that Metis can read from or write to. Connections are
          project-scoped — pick a category below to view the aggregated surface or jump into a
          project&apos;s settings.
        </p>
      </header>
      <div
        className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3"
        data-testid="settings-integrations-grid"
      >
        {INTEGRATIONS.map((link) => (
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
