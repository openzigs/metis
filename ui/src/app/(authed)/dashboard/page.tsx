/**
 * Phase 12 — Dashboard widgets (issue #86).
 *
 * Composable grid: each widget owns its own TanStack Query (keyed so
 * widgets refetch independently at sane intervals). Mobile collapses to
 * a single column. Empty states are actionable — every widget points at
 * the page where you'd create the first record.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { projectsApi } from "@/lib/projects-api";
import { tasksApi, schedulerApi } from "@/lib/scheduler-api";
import { recentTracker } from "@/lib/recent-tracker";
import { asyncApi } from "@/lib/async-platform-api";
import { Button } from "@/components/ui/button";
import { useEffect, useState, type ReactNode } from "react";

const REFRESH_MS = 30_000;

export default function DashboardPage() {
  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="dashboard-root">
      <header>
        <h1 className="text-2xl font-semibold">Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Project health, recent activity, and quick actions.
        </p>
      </header>

      <section
        aria-label="Dashboard widgets"
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3"
      >
        <ProjectsWidget />
        <ActiveTasksWidget />
        <ActiveRunsWidget />
        <ScheduledJobsWidget />
        <RecentActivityWidget />
      </section>
    </div>
  );
}

interface WidgetShellProps {
  title: string;
  testId: string;
  loading: boolean;
  empty: boolean;
  emptyTitle: string;
  emptyCta: string;
  emptyHref?: string;
  emptyHrefLabel?: string;
  children: ReactNode;
}

function WidgetShell({
  title,
  testId,
  loading,
  empty,
  emptyTitle,
  emptyCta,
  emptyHref,
  emptyHrefLabel,
  children,
}: WidgetShellProps) {
  return (
    <Card className="p-4" data-testid={testId}>
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {loading ? (
        <div role="status" aria-live="polite" className="space-y-2">
          <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
          <div className="h-3 w-3/4 animate-pulse rounded bg-muted" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
        </div>
      ) : empty ? (
        <div
          role="status"
          className="flex flex-col items-start gap-1 rounded border border-dashed p-3 text-xs"
        >
          <p className="font-medium">{emptyTitle}</p>
          <p className="text-muted-foreground">{emptyCta}</p>
          {emptyHref && emptyHrefLabel ? (
            <Link
              href={emptyHref}
              className="text-primary underline-offset-2 hover:underline"
              data-testid={`${testId}-empty-cta`}
            >
              {emptyHrefLabel} →
            </Link>
          ) : null}
        </div>
      ) : (
        children
      )}
    </Card>
  );
}

function ProjectsWidget() {
  const q = useQuery({
    queryKey: ["dashboard", "projects"],
    queryFn: () => projectsApi.list({ limit: 5 }),
    refetchInterval: REFRESH_MS,
  });
  const items = q.data?.items ?? [];
  return (
    <WidgetShell
      title="Projects"
      testId="widget-projects"
      loading={q.isLoading}
      empty={!q.isLoading && items.length === 0}
      emptyTitle="No projects yet"
      emptyCta="Create your first project to get started."
      emptyHref="/projects"
      emptyHrefLabel="Open projects"
    >
      <ul className="space-y-1 text-sm" data-testid="widget-projects-list">
        {items.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-2">
            <Link
              href={`/projects/${p.id}`}
              className="truncate underline-offset-2 hover:underline"
            >
              {p.name}
            </Link>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{p.status}</span>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}

function ActiveTasksWidget() {
  const q = useQuery({
    queryKey: ["dashboard", "tasks", "active"],
    queryFn: () => tasksApi.list({ status: "running", take: 5 }),
    refetchInterval: REFRESH_MS / 2,
  });
  const items = q.data?.items ?? [];
  return (
    <WidgetShell
      title="Active analyses & tasks"
      testId="widget-tasks"
      loading={q.isLoading}
      empty={!q.isLoading && items.length === 0}
      emptyTitle="Nothing running"
      emptyCta="Start an analysis or trigger a scheduled job."
      emptyHref="/tasks"
      emptyHrefLabel="Open tasks"
    >
      <ul className="space-y-1 text-sm" data-testid="widget-tasks-list">
        {items.map((t) => (
          <li key={t.id} className="flex items-center justify-between gap-2">
            <span className="truncate">{t.type}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{t.status}</span>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}

function ActiveRunsWidget() {
  const q = useQuery({
    queryKey: ["dashboard", "bg-runs"],
    queryFn: () => asyncApi.listBackgroundRuns({ limit: 8 }),
    refetchInterval: REFRESH_MS / 3,
  });
  const items = (q.data?.items ?? []).filter(
    (r) => r.status === "queued" || r.status === "running" || r.status === "paused",
  );
  async function action(id: string, kind: "cancel" | "pause" | "resume") {
    if (kind === "cancel") await asyncApi.cancelBackgroundRun(id);
    if (kind === "pause") await asyncApi.pauseBackgroundRun(id);
    if (kind === "resume") await asyncApi.resumeBackgroundRun(id);
    await q.refetch();
  }
  return (
    <WidgetShell
      title="Active runs"
      testId="widget-bg-runs"
      loading={q.isLoading}
      empty={!q.isLoading && items.length === 0}
      emptyTitle="No background runs"
      emptyCta="Submit an async run from the workbench."
      emptyHref="/workbench"
      emptyHrefLabel="Open workbench"
    >
      <ul className="space-y-1 text-sm" data-testid="widget-bg-runs-list">
        {items.map((r) => (
          <li
            key={r.id}
            className="flex items-center justify-between gap-2"
            data-testid={`bg-run-${r.id}`}
          >
            <span className="truncate font-mono text-xs">{r.kind}</span>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{r.status}</span>
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                onClick={() => action(r.id, "cancel")}
                data-testid={`bg-run-cancel-${r.id}`}
              >
                Cancel
              </Button>
              {r.status === "running" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => action(r.id, "pause")}
                  data-testid={`bg-run-pause-${r.id}`}
                >
                  Pause
                </Button>
              ) : null}
              {r.status === "paused" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => action(r.id, "resume")}
                  data-testid={`bg-run-resume-${r.id}`}
                >
                  Resume
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}

function ScheduledJobsWidget() {
  const q = useQuery({
    queryKey: ["dashboard", "scheduler"],
    queryFn: () => schedulerApi.list(),
    refetchInterval: REFRESH_MS,
  });
  const items = (q.data ?? []).slice(0, 5);
  return (
    <WidgetShell
      title="Scheduled jobs"
      testId="widget-scheduler"
      loading={q.isLoading}
      empty={!q.isLoading && items.length === 0}
      emptyTitle="No scheduled jobs"
      emptyCta="Create a recurring job from the scheduler."
      emptyHref="/scheduler"
      emptyHrefLabel="Open scheduler"
    >
      <ul className="space-y-1 text-sm" data-testid="widget-scheduler-list">
        {items.map((j) => (
          <li key={j.id} className="flex items-center justify-between gap-2">
            <span className="truncate">{j.name}</span>
            <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{j.cron}</code>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}

function RecentActivityWidget() {
  const [entries, setEntries] = useState(() => recentTracker.list());
  useEffect(() => {
    const id = window.setInterval(() => setEntries(recentTracker.list()), REFRESH_MS);
    return () => window.clearInterval(id);
  }, []);
  return (
    <WidgetShell
      title="Recent activity"
      testId="widget-recent"
      loading={false}
      empty={entries.length === 0}
      emptyTitle="No recent items"
      emptyCta="Open a chat or run an analysis to start your activity log."
      emptyHref="/workbench"
      emptyHrefLabel="Open workbench"
    >
      <ul className="space-y-1 text-sm" data-testid="widget-recent-list">
        {entries.slice(0, 5).map((e) => (
          <li key={`${e.kind}:${e.id}`} className="flex items-center justify-between gap-2">
            <Link href={e.href} className="truncate underline-offset-2 hover:underline">
              {e.label || e.id}
            </Link>
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs">{e.kind}</span>
          </li>
        ))}
      </ul>
    </WidgetShell>
  );
}
