/**
 * Epic #194 (C.5) — Per-run detail page with diff viewer.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { BenchDiffViewer } from "@/components/eval/bench-diff-viewer";
import { evalApi, type BenchRunDetail } from "@/lib/eval-api";
import { queryKeys } from "@/lib/query-keys";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default function BenchRunDetailPage(_props: PageProps) {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? "";
  const detail = useQuery({
    queryKey: queryKeys.eval.run(id),
    queryFn: () => evalApi.getRun(id),
    enabled: id.length > 0,
  });

  return (
    <div className="space-y-6 p-6" data-testid="bench-run-detail">
      <div>
        <Link href="/eval/leaderboard" className="text-xs underline">
          ← Back to leaderboard
        </Link>
      </div>
      {detail.isLoading ? (
        <Card className="p-4 text-sm text-muted-foreground" data-testid="run-loading">
          Loading…
        </Card>
      ) : detail.isError ? (
        <Card className="p-4 text-sm text-red-600" data-testid="run-error">
          Failed to load benchmark run.
        </Card>
      ) : detail.data ? (
        <RunBody data={detail.data} />
      ) : null}
    </div>
  );
}

function RunBody({ data }: { data: BenchRunDetail }) {
  const { run, tasks } = data;
  const failingTasks = tasks.filter((t) => !t.passed);
  return (
    <>
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">{run.benchmark}</h1>
        <p className="text-sm text-muted-foreground">
          {run.model} · score {(run.score * 100).toFixed(1)}% · {run.passedTasks}/{run.totalTasks}{" "}
          tasks passed · status {run.status}
        </p>
      </header>
      <Card className="p-4">
        <h2 className="mb-2 text-sm font-semibold">Failing tasks ({failingTasks.length})</h2>
        {failingTasks.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-failing-tasks">
            All tasks passed.
          </p>
        ) : (
          <ul className="space-y-4">
            {failingTasks.map((task) => (
              <li key={task.id} data-testid={`failing-task-${task.id}`}>
                <div className="mb-2 flex items-center justify-between">
                  <code className="text-xs">{task.taskId}</code>
                  <span className="text-xs text-muted-foreground">
                    score {task.score.toFixed(2)} · {task.tokens} tokens
                  </span>
                </div>
                {task.error ? (
                  <pre className="mb-2 rounded border bg-red-50 p-2 text-xs">{task.error}</pre>
                ) : null}
                <BenchDiffViewer task={task} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
