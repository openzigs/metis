"use client";

/**
 * The workspace landing page (#2339): where the switcher's "Open workspace"
 * goes. It names what the workspace holds across its projects, each one click
 * away; Governing documents only while it is available (#1871).
 */
import Link from "next/link";
import { useGoverningTabVisible } from "@/lib/governing-api";
import { PageHeader } from "@/components/ui/page-header";

export function WorkspaceOverview({ workspaceId }: { workspaceId: string }): React.ReactElement {
  const governingVisible = useGoverningTabVisible(workspaceId);
  const sections = [
    {
      href: `/workspaces/${workspaceId}/traceability`,
      title: "Traceability",
      description: "Requirement coverage and cross-project links across this workspace.",
    },
    ...(governingVisible
      ? [
          {
            href: `/workspaces/${workspaceId}/governing`,
            title: "Governing documents",
            description:
              "The policies and control frameworks this workspace follows, and the rules extracted from them.",
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-6 p-6">
      <PageHeader title="Overview" description="What this workspace holds, across its projects." />
      <ul className="grid gap-4 sm:grid-cols-2">
        {sections.map((s) => (
          <li key={s.href}>
            <Link
              href={s.href}
              className="block h-full rounded-lg border p-4 transition-colors hover:bg-muted"
            >
              <span className="block font-medium text-foreground">{s.title}</span>
              <span className="mt-1 block text-sm text-muted-foreground">{s.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
