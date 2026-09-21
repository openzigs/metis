"use client";

/**
 * Phase 11 — /scheduler
 *
 * Lists scheduled jobs with CRUD + manual trigger + pause/resume + history.
 * Live updates from `scheduler:status` socket room (job created/updated, plus
 * task transitions for the most recent run).
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { SkeletonText } from "@/components/ui/skeleton";
import {
  schedulerApi,
  type CreateScheduledJobInput,
  type ScheduledJobRow,
  type TaskHandlerInfo,
  type TaskRow,
  type UpdateScheduledJobInput,
} from "@/lib/scheduler-api";
import { queryKeys } from "@/lib/query-keys";
import { computeSchedulerStats } from "@/lib/scheduler-stats";
import { useSocket } from "@/lib/socket-client";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export default function SchedulerPage() {
  const qc = useQueryClient();
  const socket = useSocket();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<ScheduledJobRow | null>(null);
  const [historyTarget, setHistoryTarget] = useState<ScheduledJobRow | null>(null);

  const jobs = useQuery({
    queryKey: queryKeys.scheduler.jobs(),
    queryFn: () => schedulerApi.list(),
  });
  const handlers = useQuery({
    queryKey: queryKeys.scheduler.handlers(),
    queryFn: () => schedulerApi.handlers(),
  });

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: queryKeys.scheduler.all }).catch(() => {});

  // Subscribe to live scheduler events. Each broadcast triggers a refetch;
  // the lists are small enough (≤ a few hundred jobs) that revalidation is
  // cheaper than maintaining client-side patches.
  useEffect(() => {
    if (!socket) return;
    socket.emit("subscribe:scheduler");
    const onAny = () => invalidate();
    socket.on("scheduler:status", onAny);
    socket.on("task:status", onAny);
    return () => {
      socket.off("scheduler:status", onAny);
      socket.off("task:status", onAny);
    };
  }, [socket, qc]);

  const remove = useMutation({
    mutationFn: (id: string) => schedulerApi.remove(id),
    onSuccess: () => invalidate(),
  });
  const pause = useMutation({
    mutationFn: (id: string) => schedulerApi.pause(id),
    onSuccess: () => invalidate(),
  });
  const resume = useMutation({
    mutationFn: (id: string) => schedulerApi.resume(id),
    onSuccess: () => invalidate(),
  });
  const runNow = useMutation({
    mutationFn: (id: string) => schedulerApi.runNow(id),
    onSuccess: () => invalidate(),
  });

  return (
    <div className="space-y-6 p-2 md:p-0">
      <header className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Scheduler</h1>
          <p className="text-sm text-muted-foreground">
            Cron-driven jobs that enqueue tasks. Pause, resume, edit, or fire a job manually. Live
            status streams in over Socket.IO.
          </p>
        </div>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button data-testid="new-job">New job</Button>
          </DialogTrigger>
          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Create scheduled job</DialogTitle>
              <DialogDescription>
                Define a cron-driven job: a key, schedule, task type, and JSON payload.
              </DialogDescription>
            </DialogHeader>
            <JobForm
              handlers={handlers.data ?? []}
              onCancel={() => setCreateOpen(false)}
              onSaved={() => {
                setCreateOpen(false);
                invalidate();
              }}
            />
          </DialogContent>
        </Dialog>
      </header>

      <SchedulerStatsHeader jobs={jobs.data} loading={jobs.isLoading} />

      <Card className="p-0">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-3">Key</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3">Cron</th>
              <th className="px-4 py-3">Next run</th>
              <th className="px-4 py-3">State</th>
              <th className="px-4 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {jobs.isLoading ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={7}>
                  Loading…
                </td>
              </tr>
            ) : (jobs.data ?? []).length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={7}>
                  No scheduled jobs yet.
                </td>
              </tr>
            ) : (
              jobs.data?.map((job) => (
                <tr key={job.id} className="border-t" data-testid={`job-row-${job.id}`}>
                  <td className="px-4 py-2 font-mono text-xs">{job.key}</td>
                  <td className="px-4 py-2">{job.name}</td>
                  <td className="px-4 py-2 font-mono text-xs">{job.taskType}</td>
                  <td className="px-4 py-2 font-mono text-xs">{job.cron}</td>
                  <td className="px-4 py-2 text-xs">
                    {job.nextRunAt ? new Date(job.nextRunAt).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-2 text-xs">
                    {job.enabled ? (
                      <span className="text-emerald-600">enabled</span>
                    ) : (
                      <span className="text-amber-600">paused</span>
                    )}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        // L1: only disable the row whose run is in flight,
                        // not every row in the table.
                        disabled={runNow.isPending && runNow.variables === job.id}
                        onClick={() => runNow.mutate(job.id)}
                        data-testid={`run-${job.id}`}
                      >
                        Run now
                      </Button>
                      {job.enabled ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => pause.mutate(job.id)}
                          data-testid={`pause-${job.id}`}
                        >
                          Pause
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => resume.mutate(job.id)}
                          data-testid={`resume-${job.id}`}
                        >
                          Resume
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setHistoryTarget(job)}
                        data-testid={`history-${job.id}`}
                      >
                        History
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setEditTarget(job)}
                        data-testid={`edit-${job.id}`}
                      >
                        Edit
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        onClick={() => {
                          if (window.confirm(`Delete scheduled job ${job.key}?`)) {
                            remove.mutate(job.id);
                          }
                        }}
                        data-testid={`delete-${job.id}`}
                      >
                        Delete
                      </Button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      <Dialog open={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit job</DialogTitle>
            <DialogDescription>
              Update this job&apos;s schedule, task type, payload, or enabled state.
            </DialogDescription>
          </DialogHeader>
          {editTarget ? (
            <JobForm
              initial={editTarget}
              handlers={handlers.data ?? []}
              onCancel={() => setEditTarget(null)}
              onSaved={() => {
                setEditTarget(null);
                invalidate();
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog
        open={historyTarget !== null}
        onOpenChange={(open) => !open && setHistoryTarget(null)}
      >
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Run history — {historyTarget?.key}</DialogTitle>
            <DialogDescription>The most recent task runs for this scheduled job.</DialogDescription>
          </DialogHeader>
          {historyTarget ? <HistoryTable jobId={historyTarget.id} /> : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SchedulerStatsHeader({
  jobs,
  loading,
}: {
  jobs: ScheduledJobRow[] | undefined;
  loading: boolean;
}) {
  const stats = computeSchedulerStats(jobs);
  const cards: { label: string; value: string; testid: string }[] = [
    { label: "Total jobs", value: String(stats.total), testid: "stat-total" },
    { label: "Enabled", value: String(stats.enabled), testid: "stat-enabled" },
    { label: "Paused", value: String(stats.paused), testid: "stat-paused" },
    {
      label: "Next run",
      value: stats.nextRunAt ? new Date(stats.nextRunAt).toLocaleString() : "—",
      testid: "stat-next-run",
    },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-testid="scheduler-stats">
      {cards.map((c) => (
        <Card key={c.testid} className="p-4" data-testid={c.testid}>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">{c.label}</p>
          <p className="mt-1 text-xl font-semibold tabular-nums">{loading ? "…" : c.value}</p>
        </Card>
      ))}
    </div>
  );
}

function HistoryTable({ jobId }: { jobId: string }) {
  const history = useQuery({
    queryKey: queryKeys.scheduler.history(jobId),
    queryFn: () => schedulerApi.history(jobId),
  });
  if (history.isLoading) return <SkeletonText lines={3} />;
  const items = history.data ?? [];
  if (items.length === 0) return <p className="text-sm text-muted-foreground">No runs yet.</p>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="text-xs uppercase text-muted-foreground">
        <tr>
          <th className="py-2">Task</th>
          <th className="py-2">Trigger</th>
          <th className="py-2">Status</th>
          <th className="py-2">Started</th>
          <th className="py-2">Completed</th>
        </tr>
      </thead>
      <tbody>
        {items.map((task: TaskRow) => (
          <tr key={task.id} className="border-t">
            <td className="py-2 font-mono text-xs">{task.id}</td>
            <td className="py-2 text-xs">{task.trigger}</td>
            <td className="py-2 text-xs">{task.status}</td>
            <td className="py-2 text-xs">
              {task.startedAt ? new Date(task.startedAt).toLocaleString() : "—"}
            </td>
            <td className="py-2 text-xs">
              {task.completedAt ? new Date(task.completedAt).toLocaleString() : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

interface JobFormProps {
  initial?: ScheduledJobRow;
  handlers: TaskHandlerInfo[];
  onCancel: () => void;
  onSaved: () => void;
}

function JobForm({ initial, handlers, onCancel, onSaved }: JobFormProps) {
  const isEdit = Boolean(initial);
  const [key, setKey] = useState(initial?.key ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [cron, setCron] = useState(initial?.cron ?? "*/15 * * * *");
  const [taskType, setTaskType] = useState(
    initial?.taskType ?? handlers[0]?.type ?? "http-webhook",
  );
  const [maxAttempts, setMaxAttempts] = useState(initial?.maxAttempts ?? 3);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [payloadText, setPayloadText] = useState(() => {
    if (!initial?.payload) return "{}";
    try {
      return JSON.stringify(JSON.parse(initial.payload), null, 2);
    } catch {
      return initial.payload;
    }
  });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(payloadText);
      } catch {
        throw new Error("payload is not valid JSON");
      }
      if (isEdit && initial) {
        const update: UpdateScheduledJobInput = {
          name,
          cron,
          taskType,
          payload,
          enabled,
          maxAttempts,
        };
        return schedulerApi.update(initial.id, update);
      }
      const create: CreateScheduledJobInput = {
        key,
        name,
        cron,
        taskType,
        payload,
        enabled,
        maxAttempts,
      };
      return schedulerApi.create(create);
    },
    onSuccess: () => {
      setError(null);
      onSaved();
    },
    onError: (err: unknown) => {
      if (err instanceof ApiError) setError(err.message);
      else if (err instanceof Error) setError(err.message);
      else setError("Failed to save");
    },
  });

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      {!isEdit ? (
        <div>
          <Label htmlFor="key">Key</Label>
          <Input id="key" value={key} onChange={(e) => setKey(e.target.value)} required />
        </div>
      ) : null}
      <div>
        <Label htmlFor="name">Name</Label>
        <Input id="name" value={name} onChange={(e) => setName(e.target.value)} required />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="cron">Cron expression</Label>
          <Input
            id="cron"
            value={cron}
            onChange={(e) => setCron(e.target.value)}
            placeholder="*/15 * * * *"
            required
          />
        </div>
        <div>
          <Label htmlFor="taskType">Task type</Label>
          <select
            id="taskType"
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            value={taskType}
            onChange={(e) => setTaskType(e.target.value)}
          >
            {handlers.map((h) => (
              <option key={h.type} value={h.type}>
                {h.type}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="maxAttempts">Max attempts</Label>
          <Input
            id="maxAttempts"
            type="number"
            min={1}
            max={10}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(Number.parseInt(e.target.value, 10) || 1)}
          />
        </div>
        <label className="flex items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>
      </div>
      <div>
        <Label htmlFor="payload">Payload (JSON)</Label>
        <textarea
          id="payload"
          className="h-40 w-full rounded-md border border-input bg-background p-2 font-mono text-xs"
          value={payloadText}
          onChange={(e) => setPayloadText(e.target.value)}
        />
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending} data-testid="save-job">
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
