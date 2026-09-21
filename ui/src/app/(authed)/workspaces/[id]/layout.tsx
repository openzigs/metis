"use client";

/**
 * Workspace-scoped layout (Epic #47 / Issue #54).
 *
 * Establishes the `/workspaces/:id` surface — no such route existed before
 * the FinOps page. Provides a thin header + the workspace-section nav so
 * future workspace sub-pages can slot in alongside `finops`.
 */
import { useParams, usePathname } from "next/navigation";
import Link from "next/link";

export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const params = useParams<{ id: string }>();
  const pathname = usePathname();
  const id = params?.id ?? "";

  if (!id) return <div className="p-6">Invalid workspace id.</div>;

  const tabs = [
    { href: `/workspaces/${id}/finops`, label: "FinOps" },
    { href: `/workspaces/${id}/traceability`, label: "Traceability" },
    { href: `/workspaces/${id}/agents/new`, label: "New Agent" },
  ];

  return (
    <div className="flex flex-col">
      <nav className="flex gap-2 border-b px-6 py-2">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={`rounded px-3 py-1 text-sm font-medium ${
              pathname === t.href
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
