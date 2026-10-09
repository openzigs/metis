/**
 * Epic #396 (MVP-4) — `/speckit.taskstoissues` command.
 *
 * Parses the feature's `tasks.md` and creates one GitHub issue per row,
 * tagged with the user-story slug, with `Parallelizable: yes/no`, the
 * referenced files, and `Source: specs/<slug>/tasks.md#T<NN>` for
 * traceability. Re-exports upsert by `(featureSlug, taskId)`.
 *
 * Issue creation goes through a pluggable `IssueClient` so the command is
 * fully testable without a live GitHub. Without an injected client only a dry
 * run is served, and a real run is refused 501 rather than "exporting" to the
 * no-op client and recording every task as issue #0 (#784). The production
 * client — vault-bound, target-guarded — is built per request by
 * `./taskstoissues-github.ts` (#953), which is the only live caller.
 *
 * #953 — a dry run returns the `tasks.md` version it read and a `planDigest`
 * of exactly what a live run would create there. A live run given
 * `expectedPlan` recomputes both and refuses 409 before creating anything when
 * either differs, so it files exactly the issues the user previewed.
 *
 * The destination is never the project's analysed `RepoConnection` (#784) —
 * for an analysed open-source project that is someone else's upstream.
 */
import { createHash, randomUUID } from "node:crypto";
import { prisma } from "../../prisma.js";
import { audit } from "../../audit/audit-service.js";
import { resolveFeatureBySlug } from "../features.js";
import { getFeatureArtifact } from "../feature-artifacts.js";
import { requireGate } from "../gates.js";
import { parseTasksMarkdown, type ParsedTask } from "../tasks-parser.js";
import { SpecKitArtifactError } from "../artifacts.js";
import { findSavedGitHubTarget } from "../../publishing/saved-target.js";

export interface IssueCreateRequest {
  title: string;
  body: string;
  labels: string[];
}

export interface IssueCreatedResponse {
  number: number;
  url: string;
}

export interface IssueClient {
  create(
    repoOwner: string,
    repoName: string,
    req: IssueCreateRequest,
  ): Promise<IssueCreatedResponse>;
  /** Optional: link `child` as a sub-issue of `parent`. No-op when unsupported. */
  addSubIssue?(repoOwner: string, repoName: string, parent: number, child: number): Promise<void>;
  /**
   * #962 — find the issue an earlier run of this task may have created: titled
   * `[<taskId>] …`, with the task's `Source:` line, updated since `since`. Only
   * ever called with the run's guarded target. A run with a claim to reconcile
   * and a client without this is refused rather than risk a duplicate.
   */
  findTaskIssue?(
    repoOwner: string,
    repoName: string,
    query: { taskId: string; featureSlug: string; since: Date },
  ): Promise<IssueCreatedResponse | null>;
}

/**
 * #962 — what a run does (dry) or did (live) with a task: `new` creates an
 * issue; `exported` already has one; `in_progress` is claimed by a live run
 * still within `SPECKIT_EXPORT_CLAIM_TTL_MS`; `reconcile` is an abandoned or
 * kept claim a live run will look for on GitHub before creating; `adopted` is
 * one it found there.
 */
export type TaskExportState = "new" | "exported" | "in_progress" | "reconcile" | "adopted";

export const SPECKIT_EXPORT_DEFAULT_CLAIM_TTL_MS = 10 * 60_000;

/** #962 — how long a live run's claim on a task counts as in progress. */
export function claimTtlMs(): number {
  const n = Number.parseInt(process.env.SPECKIT_EXPORT_CLAIM_TTL_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : SPECKIT_EXPORT_DEFAULT_CLAIM_TTL_MS;
}

const NOT_CREATED = Symbol.for("metis.speckit.issueNotCreated");

/**
 * #962 — mark an issue-client failure as definitive: GitHub answered and
 * created nothing (a 4xx). Any failure not so marked is ambiguous, and the
 * task's claim is kept for reconciliation instead of released.
 */
export function markIssueNotCreated<E extends object>(err: E): E {
  Object.defineProperty(err, NOT_CREATED, { value: true });
  return err;
}

export function isIssueNotCreated(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<symbol, unknown>)[NOT_CREATED] === true
  );
}

export interface TasksToIssuesInput {
  projectId: string;
  featureSlug: string;
  /**
   * Override resolved repo. Otherwise: `SpecKitConfig.tasksToIssuesRepo`, the
   * project's saved publish target (#733), then `SPECKIT_TASKS_DEFAULT_REPO`.
   */
  repo?: { owner: string; name: string };
  /** Override parent epic. Falls back to `SpecKitConfig.tasksToIssuesParentEpic`. */
  parentEpicNumber?: number;
  /**
   * Pluggable issue client. Required for a non-dry run (#784): without one a
   * real run is refused 501. A dry run never calls it, injected or not.
   */
  client?: IssueClient;
  actorId?: string | null;
  /**
   * When true, parses + plans only — no issue-client calls of any kind (not
   * `create`, not `addSubIssue`) and no DB writes, even when a real client is
   * injected (#784).
   */
  dryRun?: boolean;
  /** Bypass the tasksGate (audit-emitted high-severity event). */
  force?: boolean;
  /**
   * #953 — the dry run this live run must reproduce: the `tasks.md` version it
   * read and its `planDigest`. A mismatch is refused 409
   * SPECKIT_EXPORT_PLAN_CHANGED before any issue is created. Ignored on a dry run.
   */
  expectedPlan?: { tasksVersion: number; digest: string };
  /**
   * #953 — refuse (422 SPECKIT_EXPORT_TOO_LARGE) a live run that would create
   * more issues than this. Ignored on a dry run, which only lists them.
   */
  maxCreates?: number;
  /**
   * #993 — export only these task ids (in tasks.md order). Omitted ⇒ every
   * task. The plan digest covers the selection, so a live run must send the
   * same subset its dry run previewed.
   */
  taskIds?: string[];
  /** #962 — the id this live run claims tasks under. Generated when omitted. */
  runId?: string;
  /**
   * #953 — reported as `publishAvailable`. Defaults to whether a client was
   * injected; the route's dry run says true, since its live run builds one.
   */
  publishAvailable?: boolean;
}

export interface TasksToIssuesResult {
  count: number;
  /** `title` is the issue title, planned or created (#936: a dry run lists them). */
  created: Array<{
    taskId: string;
    title: string;
    issueNumber: number;
    url: string;
    upserted: boolean;
    /** #962 — see {@link TaskExportState}. */
    state: TaskExportState;
  }>;
  /** #993 — every task in tasks.md, selected or not, for choosing a subset. */
  available: Array<{ taskId: string; title: string }>;
  repo: { owner: string; name: string };
  parentEpicNumber: number | null;
  /**
   * #936 — whether a non-dry run of this call would reach a real issue client,
   * so a UI can say so instead of offering a Publish that is refused 501.
   */
  publishAvailable: boolean;
  /** #953 — the `tasks.md` version this run read. */
  tasksVersion: number;
  /**
   * #953 — SHA-256 over the project, feature, `tasks.md` version, target repo
   * and the ordered titles a live run would create. A live run must present
   * the dry run's value as `expectedPlan.digest`.
   */
  planDigest: string;
  message: string;
}

/**
 * #953 — the digest that binds a live run to its dry run. Not a secret and not
 * an authenticator: it lets the server prove the live run creates exactly the
 * titles that were previewed, against the same target, from the same version.
 */
export function computePlanDigest(plan: {
  projectId: string;
  featureSlug: string;
  tasksVersion: number;
  repo: { owner: string; name: string };
  titles: string[];
  /** #962 — titles of claimed tasks a live run reconciles (adopts or creates). */
  reconcile?: string[];
  /** #962 — titles of tasks another run is exporting. */
  inProgress?: string[];
  /** The epic new issues are linked under; a different one is a different plan. */
  parentEpicNumber?: number | null;
  /** #993 — the chosen subset of task ids, normalised; null/omitted ⇒ every task. */
  taskIds?: string[] | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        plan.projectId,
        plan.featureSlug,
        plan.tasksVersion,
        `${plan.repo.owner}/${plan.repo.name}`.toLowerCase(),
        plan.titles,
        plan.parentEpicNumber ?? null,
        plan.reconcile ?? [],
        plan.inProgress ?? [],
        plan.taskIds ?? null,
      ]),
    )
    .digest("hex");
}

/** The placeholder a dry run reports for an issue it would create. */
function plannedIssue(title: string): IssueCreatedResponse {
  return { number: 0, url: `dryrun://${encodeURIComponent(title)}` };
}

export const noopIssueClient: IssueClient = {
  async create(_o, _n, req) {
    return plannedIssue(req.title);
  },
};

export async function runTasksToIssues(input: TasksToIssuesInput): Promise<TasksToIssuesResult> {
  // #953 — every refusal of a live export is audited, the planning stage's
  // included (404, the tasks gate and tasks.md 412s, a cycle, a claim in
  // progress, a changed plan, an oversized one). A failure part-way through
  // creating issues is audited separately, below, as `tasks_export_failed`.
  const live = !input.dryRun && Boolean(input.client);
  const seen: { featureId: string | null } = { featureId: null };
  let planned: Awaited<ReturnType<typeof planTasksExport>>;
  try {
    planned = await planTasksExport(input, seen);
  } catch (err) {
    if (live) {
      auditTasksExportRefused({
        actorId: input.actorId ?? null,
        projectId: input.projectId,
        featureSlug: input.featureSlug,
        featureId: seen.featureId,
        err,
      });
    }
    throw err;
  }
  if ("empty" in planned) return planned.empty;
  const { feature, plan, repo, parentEpicNumber, client, available, tasksVersion, planDigest } =
    planned;
  const publishAvailable = input.publishAvailable ?? Boolean(input.client);
  const runId = input.runId ?? randomUUID();
  const created: TasksToIssuesResult["created"] = [];
  const idToIssueNumber = new Map<string, number>();

  const exportOne = async ({
    task,
    title,
    existing,
    state,
  }: PlanStep): Promise<TasksToIssuesResult["created"][number]> => {
    let issueNumber: number;
    let url: string;
    let wasUpsert = false;
    let outState: TaskExportState = state;
    if (state === "exported" && existing) {
      issueNumber = existing.issueNumber;
      url = `https://github.com/${existing.repoOwner}/${existing.repoName}/issues/${issueNumber}`;
      wasUpsert = true;
    } else if (!client) {
      // Dry run: report the plan, call nothing, write nothing.
      const planned = plannedIssue(title);
      issueNumber = planned.number;
      url = planned.url;
    } else {
      const resolved = await createOrAdopt({
        client,
        repo,
        runId,
        projectId: input.projectId,
        featureSlug: feature.slug,
        task,
        title,
        existing: state === "reconcile" ? existing : null,
      });
      issueNumber = resolved.number;
      url = resolved.url;
      outState = resolved.adopted ? "adopted" : "new";
    }
    idToIssueNumber.set(task.id, issueNumber);

    // Link sub-issues to parent epic if supported. An adopted issue is linked
    // too: the run that created it stopped before it could link it.
    if (parentEpicNumber !== null && client?.addSubIssue && !wasUpsert) {
      try {
        await client.addSubIssue(repo.owner, repo.name, parentEpicNumber, issueNumber);
      } catch (err) {
        warnSubIssueFailure({
          actorId: input.actorId ?? null,
          featureSlug: feature.slug,
          parent: parentEpicNumber,
          child: issueNumber,
          err,
        });
      }
    }
    // Link to dependency issues.
    if (client?.addSubIssue) {
      for (const dep of task.dependsOn) {
        const depNum = idToIssueNumber.get(dep);
        if (depNum) {
          try {
            await client.addSubIssue(repo.owner, repo.name, depNum, issueNumber);
          } catch (err) {
            warnSubIssueFailure({
              actorId: input.actorId ?? null,
              featureSlug: feature.slug,
              parent: depNum,
              child: issueNumber,
              err,
            });
          }
        }
      }
    }
    return {
      taskId: task.id,
      title,
      issueNumber,
      url,
      upserted: wasUpsert,
      state: outState,
    };
  };

  try {
    for (const step of plan) created.push(await exportOne(step));
  } catch (err) {
    // #953 — a live export that stops part-way has still created issues on
    // GitHub; record how far it got. The created ones are persisted, so a
    // retry upserts them rather than filing them twice.
    if (client) {
      audit({
        actor: input.actorId ? { id: input.actorId } : null,
        action: "speckit.tasks_export_failed",
        target: { type: "speckit_feature", id: feature.id },
        metadata: {
          featureSlug: feature.slug,
          repo: `${repo.owner}/${repo.name}`,
          tasksVersion,
          planDigest,
          runId,
          createdBeforeFailure: created.filter((c) => !c.upserted).length,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    }
    throw err;
  }

  audit({
    actor: input.actorId ? { id: input.actorId } : null,
    action: "speckit.tasks_exported",
    target: { type: "speckit_feature", id: feature.id },
    metadata: {
      featureSlug: feature.slug,
      count: created.length,
      repo: `${repo.owner}/${repo.name}`,
      parentEpicNumber,
      dryRun: input.dryRun ?? false,
      tasksVersion,
      planDigest,
      ...(client ? { runId } : {}),
      created: created.filter((c) => c.state === "new").length,
      adopted: created.filter((c) => c.state === "adopted").length,
    },
  });

  return {
    count: created.length,
    created,
    available,
    repo,
    parentEpicNumber,
    publishAvailable,
    tasksVersion,
    planDigest,
    message: `${input.dryRun ? "Would export" : "Exported"} ${created.length} task(s) to ${repo.owner}/${repo.name}.`,
  };
}

interface PlanStep {
  task: ParsedTask;
  title: string;
  existing: ExportRow | null;
  state: Exclude<TaskExportState, "adopted">;
}

/**
 * Everything a run decides before it creates anything: the gate, tasks.md,
 * the target, and each task's state. Throws every planning-stage refusal;
 * `seen.featureId` is set as soon as the feature resolves, for the audit.
 */
async function planTasksExport(
  input: TasksToIssuesInput,
  seen: { featureId: string | null },
): Promise<
  | { empty: TasksToIssuesResult }
  | {
      feature: { id: string; slug: string };
      plan: PlanStep[];
      repo: { owner: string; name: string };
      parentEpicNumber: number | null;
      client: IssueClient | null;
      available: TasksToIssuesResult["available"];
      tasksVersion: number;
      planDigest: string;
    }
> {
  const feature = await resolveFeatureBySlug(input.projectId, input.featureSlug);
  if (!feature) {
    throw new SpecKitArtifactError(
      404,
      "SPECKIT_FEATURE_NOT_FOUND",
      `Feature not found: ${input.featureSlug}`,
    );
  }
  seen.featureId = feature.id;
  // Gate: tasks.md must exist (412).
  await requireGate({
    featureId: feature.id,
    gate: "tasksGate",
    force: input.force ?? false,
    actorId: input.actorId ?? null,
    command: "speckit.taskstoissues",
  });

  const tasksArt = await getFeatureArtifact(feature.id, "tasks.md");
  if (!tasksArt) {
    // #786 — `x-speckit-force` bypasses the phase gate, but no header can export
    // tasks that do not exist; name the command that writes them.
    throw new SpecKitArtifactError(
      412,
      "SPECKIT_GATE_UNMET",
      `tasks.md is required, even with x-speckit-force: there is nothing to export — run /speckit.tasks with featureSlug ${feature.slug} first`,
    );
  }
  const allTasks = parseTasksMarkdown(tasksArt.content);
  const tasks = selectTasks(allTasks, input.taskIds);
  const publishAvailable = input.publishAvailable ?? Boolean(input.client);
  const tasksVersion = tasksArt.version;
  const available = allTasks.map((t) => ({ taskId: t.id, title: issueTitle(t) }));
  if (tasks.length === 0) {
    const repo = input.repo ?? { owner: "", name: "" };
    return {
      empty: {
        count: 0,
        created: [],
        available,
        repo,
        parentEpicNumber: input.parentEpicNumber ?? null,
        publishAvailable,
        tasksVersion,
        planDigest: computePlanDigest({
          projectId: input.projectId,
          featureSlug: feature.slug,
          tasksVersion,
          repo,
          titles: [],
        }),
        message: "No tasks found in tasks.md.",
      },
    };
  }

  // #784 — refuse before resolving a target or creating anything: the no-op client creates nothing,
  // so persisting its synthetic issue #0 would pin every task to a phantom
  // issue that each later run "upserts" onto.
  if (!input.dryRun && !input.client) {
    throw new SpecKitArtifactError(
      501,
      "SPECKIT_ISSUE_EXPORT_UNAVAILABLE",
      "Exporting tasks to GitHub issues is not available on this server yet. Preview the export with a dry run instead.",
    );
  }
  const repo = input.repo ?? (await resolveTasksExportRepo(input.projectId));
  const parentEpicNumber = input.parentEpicNumber ?? (await resolveParentEpic(input.projectId));
  // #784 — a dry run must never reach a client: once a real one is injected, a
  // "preview" would otherwise file real issues. Past the guard above, a
  // non-dry run always has one, so `client === null` exactly when dry.
  const client: IssueClient | null = input.dryRun ? null : (input.client ?? null);

  // Topologically iterate so deps are created before children. #953 — the
  // whole plan (what already exists, what would be created) is read before
  // any issue is, so a dry run reports the same plan a live run executes and a
  // live run can be checked against it up front. Reading the export rows is
  // not a write: a dry run still persists nothing.
  const plan: PlanStep[] = [];
  const now = Date.now();
  const ttl = claimTtlMs();
  for (const task of topoSort(tasks)) {
    const existing = (await prisma.specKitTaskExport.findUnique({
      where: {
        projectId_featureSlug_taskId: {
          projectId: input.projectId,
          featureSlug: feature.slug,
          taskId: task.id,
        },
      },
    })) as ExportRow | null;
    const title = issueTitle(task);
    if (!existing) {
      plan.push({ task, title, existing: null, state: "new" });
    } else if (existing.issueNumber !== 0) {
      plan.push({ task, title, existing, state: "exported" });
    } else {
      // #953/#962 — issueNumber 0 is a claim. One a live run still holds is in
      // progress: a live run refuses rather than race it. One no run holds
      // (kept after an ambiguous GitHub failure) or older than the TTL
      // (its run died) is reconciled against the target before re-creating.
      const state = claimStateOf(existing, now, ttl);
      if (state === "in_progress" && client) {
        throw new SpecKitArtifactError(
          409,
          "SPECKIT_EXPORT_IN_PROGRESS",
          `Another export of this feature is in progress (task ${task.id}). Wait for it to finish, then preview again.`,
        );
      }
      plan.push({ task, title, existing, state });
    }
  }
  const toCreate = plan.filter((p) => p.state === "new").map((p) => p.title);
  const toReconcile = plan.filter((p) => p.state === "reconcile").map((p) => p.title);
  const planDigest = computePlanDigest({
    projectId: input.projectId,
    featureSlug: feature.slug,
    tasksVersion,
    repo,
    titles: toCreate,
    reconcile: toReconcile,
    inProgress: plan.filter((p) => p.state === "in_progress").map((p) => p.title),
    parentEpicNumber,
    taskIds: input.taskIds ? tasks.map((t) => t.id) : null,
  });
  if (client) {
    assertPlanUnchanged(input.expectedPlan, tasksVersion, planDigest);
    const mayCreate = toCreate.length + toReconcile.length;
    if (input.maxCreates !== undefined && mayCreate > input.maxCreates) {
      throw new SpecKitArtifactError(
        422,
        "SPECKIT_EXPORT_TOO_LARGE",
        `This export would create ${mayCreate} issues; one export may create at most ${input.maxCreates}. Choose fewer tasks for the dry run, then publish the rest in a later export.`,
      );
    }
    if (toReconcile.length > 0 && !client.findTaskIssue) {
      // Fail closed: re-creating without looking first could file a duplicate.
      throw new SpecKitArtifactError(
        409,
        "SPECKIT_EXPORT_RECONCILE_UNAVAILABLE",
        "An earlier export of this feature stopped before it could record its issues, and this server cannot check GitHub for them. Nothing was created.",
      );
    }
  }
  return {
    feature,
    plan,
    repo,
    parentEpicNumber,
    client,
    available,
    tasksVersion,
    planDigest,
  };
}

/**
 * #993 — the tasks an export covers: all of them, or the chosen subset in
 * tasks.md order. A chosen id tasks.md does not have is refused rather than
 * silently dropped, so a stale selection never publishes less than it shows.
 */
function selectTasks(tasks: ParsedTask[], taskIds: string[] | undefined): ParsedTask[] {
  if (!taskIds) return tasks;
  const wanted = new Set(taskIds.map((id) => id.toUpperCase()));
  const known = new Set(tasks.map((t) => t.id));
  const unknown = [...wanted].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new SpecKitArtifactError(
      400,
      "SPECKIT_EXPORT_UNKNOWN_TASK",
      `tasks.md has no task ${unknown.join(", ")}. Run the dry run again and pick from the tasks it lists.`,
    );
  }
  return tasks.filter((t) => wanted.has(t.id));
}

/**
 * #953/#962 — create one task's issue under a claim, or adopt the issue an
 * earlier run filed. `existing` is a reconcilable claim (abandoned, or kept
 * after an ambiguous failure); null means the task has no row yet.
 *
 * The claim is taken before GitHub is called — a unique insert for a new task,
 * a compare-and-swap on the lease (`claimedAt`, `claimRunId`) for a
 * reconcilable one — so exactly one run acts on a task. A takeover moves the
 * lease but never `firstClaimedAt`, which the search starts from. Then, for a reconcilable claim, the
 * target is searched for the issue first. On a GitHub failure the claim is
 * released only when GitHub definitely created nothing (a 4xx); on an
 * ambiguous one (network error, 5xx, malformed 2xx) it is kept, ownerless, so
 * the next run reconciles instead of filing a duplicate.
 */
async function createOrAdopt(opts: {
  client: IssueClient;
  repo: { owner: string; name: string };
  runId: string;
  projectId: string;
  featureSlug: string;
  task: ParsedTask;
  title: string;
  existing: ExportRow | null;
}): Promise<IssueCreatedResponse & { adopted: boolean }> {
  const { client, repo, runId, task, title, existing } = opts;
  const key = {
    projectId: opts.projectId,
    featureSlug: opts.featureSlug,
    taskId: task.id,
  };
  const mine = { ...key, issueNumber: 0, claimRunId: runId };
  const inProgress = () =>
    new SpecKitArtifactError(
      409,
      "SPECKIT_EXPORT_IN_PROGRESS",
      "Another export of this feature is in progress. Wait for it to finish, then preview again.",
    );
  if (existing) {
    const taken = await prisma.specKitTaskExport.updateMany({
      where: {
        ...key,
        issueNumber: 0,
        claimRunId: existing.claimRunId,
        claimedAt: existing.claimedAt,
      },
      // The lease moves to this run; the first claim time never does (#962).
      data: { claimRunId: runId, claimedAt: new Date(), firstClaimedAt: firstClaimOf(existing) },
    });
    if (taken.count !== 1) throw inProgress();
    let found: IssueCreatedResponse | null;
    try {
      // Checked by the plan stage: a reconcile never runs without it.
      found = await client.findTaskIssue!(repo.owner, repo.name, {
        taskId: task.id,
        featureSlug: opts.featureSlug,
        since: firstClaimOf(existing),
      });
    } catch (err) {
      await releaseClaim(mine);
      throw err;
    }
    if (found) {
      await prisma.specKitTaskExport.update({
        where: { projectId_featureSlug_taskId: key },
        data: {
          issueNumber: found.number,
          repoOwner: repo.owner,
          repoName: repo.name,
          claimRunId: null,
        },
      });
      return { ...found, adopted: true };
    }
  } else {
    const claimed = new Date();
    try {
      await prisma.specKitTaskExport.create({
        data: {
          ...key,
          issueNumber: 0,
          repoOwner: repo.owner,
          repoName: repo.name,
          claimedAt: claimed,
          firstClaimedAt: claimed,
          claimRunId: runId,
        },
      });
    } catch (err) {
      if ((err as { code?: string }).code === "P2002") throw inProgress();
      throw err;
    }
  }
  const labels = [githubLabel("speckit:", opts.featureSlug)];
  if (task.userStorySlug) labels.push(githubLabel("story:", task.userStorySlug));
  let resp: IssueCreatedResponse;
  try {
    resp = await client.create(repo.owner, repo.name, {
      title,
      body: renderIssueBody(task, opts.featureSlug),
      labels,
    });
  } catch (err) {
    if (isIssueNotCreated(err)) {
      // GitHub answered and created nothing: drop the claim so a retry creates it.
      await prisma.specKitTaskExport.deleteMany({ where: mine });
    } else {
      await releaseClaim(mine);
    }
    throw err;
  }
  // An upsert, not an update: the issue exists, so it is recorded even if the
  // claim was cleared meanwhile.
  await prisma.specKitTaskExport.upsert({
    where: { projectId_featureSlug_taskId: key },
    create: {
      ...key,
      issueNumber: resp.number,
      repoOwner: repo.owner,
      repoName: repo.name,
      claimRunId: null,
    },
    update: {
      issueNumber: resp.number,
      repoOwner: repo.owner,
      repoName: repo.name,
      claimRunId: null,
    },
  });
  return { ...resp, adopted: false };
}

/**
 * Keep a claim this run holds but give up ownership: GitHub may have created
 * the issue, so the next run must look for it before creating one.
 */
async function releaseClaim(mine: Record<string, unknown>): Promise<void> {
  await prisma.specKitTaskExport.updateMany({
    where: mine,
    data: { claimRunId: null },
  });
}

export interface ClearStuckExportInput {
  projectId: string;
  featureSlug: string;
  /** The guarded publish target; searched, and nothing else. */
  repo: { owner: string; name: string };
  client: IssueClient;
  actorId?: string | null;
  runId?: string;
}

export interface ClearStuckExportResult {
  /** Claims with no issue on GitHub: deleted, so the next export creates them. */
  cleared: string[];
  /** Claims whose issue an earlier run did file: now recorded as exported. */
  adopted: Array<{ taskId: string; issueNumber: number; url: string }>;
  /** Claims a live run still holds: left alone. */
  inProgress: string[];
  repo: { owner: string; name: string };
  message: string;
}

/**
 * #962 — "Clear stuck export": resolve every abandoned or kept claim of a
 * feature by the same reconciliation a live run does. An issue found on the
 * target is recorded; otherwise the claim is deleted. A claim a live run still
 * holds (younger than the TTL) is left alone, never deleted under it.
 */
export async function clearStuckTaskExports(
  input: ClearStuckExportInput,
): Promise<ClearStuckExportResult> {
  const feature = await resolveFeatureBySlug(input.projectId, input.featureSlug);
  if (!feature) {
    throw new SpecKitArtifactError(
      404,
      "SPECKIT_FEATURE_NOT_FOUND",
      `Feature not found: ${input.featureSlug}`,
    );
  }
  if (!input.client.findTaskIssue) {
    throw new SpecKitArtifactError(
      409,
      "SPECKIT_EXPORT_RECONCILE_UNAVAILABLE",
      "This server cannot check GitHub for the issues a stuck export may have created, so it cannot clear it safely.",
    );
  }
  const runId = input.runId ?? randomUUID();
  const { repo } = input;
  const claims = (await prisma.specKitTaskExport.findMany({
    where: {
      projectId: input.projectId,
      featureSlug: feature.slug,
      issueNumber: 0,
    },
    orderBy: { taskId: "asc" },
  })) as Array<ExportRow & { taskId: string }>;
  const now = Date.now();
  const ttl = claimTtlMs();
  const out: ClearStuckExportResult = {
    cleared: [],
    adopted: [],
    inProgress: [],
    repo,
    message: "",
  };
  try {
    for (const claim of claims) {
      if (claimStateOf(claim, now, ttl) === "in_progress") {
        out.inProgress.push(claim.taskId);
        continue;
      }
      const key = {
        projectId: input.projectId,
        featureSlug: feature.slug,
        taskId: claim.taskId,
      };
      const mine = { ...key, issueNumber: 0, claimRunId: runId };
      const taken = await prisma.specKitTaskExport.updateMany({
        where: {
          ...key,
          issueNumber: 0,
          claimRunId: claim.claimRunId,
          claimedAt: claim.claimedAt,
        },
        data: { claimRunId: runId, claimedAt: new Date(), firstClaimedAt: firstClaimOf(claim) },
      });
      if (taken.count !== 1) {
        out.inProgress.push(claim.taskId);
        continue;
      }
      let found: IssueCreatedResponse | null;
      try {
        found = await input.client.findTaskIssue(repo.owner, repo.name, {
          taskId: claim.taskId,
          featureSlug: feature.slug,
          since: firstClaimOf(claim),
        });
      } catch (err) {
        await releaseClaim(mine);
        throw err;
      }
      if (found) {
        await prisma.specKitTaskExport.update({
          where: { projectId_featureSlug_taskId: key },
          data: {
            issueNumber: found.number,
            repoOwner: repo.owner,
            repoName: repo.name,
            claimRunId: null,
          },
        });
        out.adopted.push({
          taskId: claim.taskId,
          issueNumber: found.number,
          url: found.url,
        });
      } else {
        await prisma.specKitTaskExport.deleteMany({ where: mine });
        out.cleared.push(claim.taskId);
      }
    }
  } finally {
    audit({
      actor: input.actorId ? { id: input.actorId } : null,
      action: "speckit.tasks_export_claims_cleared",
      target: { type: "speckit_feature", id: feature.id },
      metadata: {
        projectId: input.projectId,
        featureSlug: feature.slug,
        repo: `${repo.owner}/${repo.name}`,
        runId,
        cleared: out.cleared,
        adopted: out.adopted.map((a) => `${a.taskId}#${a.issueNumber}`),
        inProgress: out.inProgress,
        claims: claims.length,
      },
    });
  }
  out.message =
    claims.length === 0
      ? "No stuck export: no task of this feature is claimed."
      : [
          out.adopted.length ? `Recorded ${out.adopted.length} issue(s) GitHub already had.` : "",
          out.cleared.length ? `Cleared ${out.cleared.length} claim(s) with no issue.` : "",
          out.inProgress.length
            ? `${out.inProgress.length} task(s) are still being exported; try again in a few minutes.`
            : "",
        ]
          .filter(Boolean)
          .join(" ");
  return out;
}

/** Audit one refused live export (or stuck-export clear). Never the token. */
export function auditTasksExportRefused(opts: {
  actorId: string | null;
  projectId: string;
  featureSlug: string;
  featureId: string | null;
  err: unknown;
  operation?: "export" | "clear";
}): void {
  const code = (opts.err as { code?: unknown } | null)?.code;
  audit({
    actor: opts.actorId ? { id: opts.actorId } : null,
    action: "speckit.tasks_export_refused",
    target: { type: "speckit_feature", id: opts.featureId ?? opts.featureSlug },
    metadata: {
      projectId: opts.projectId,
      featureSlug: opts.featureSlug,
      operation: opts.operation ?? "export",
      code: typeof code === "string" ? code : "UNEXPECTED",
    },
  });
}

interface ExportRow {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
  claimedAt: Date | null;
  firstClaimedAt?: Date | null;
  claimRunId: string | null;
  createdAt?: Date;
}

/**
 * #962 — when the task was first claimed: the time reconciliation searches
 * GitHub from. Never the lease (`claimedAt`), which a takeover moves; a claim
 * from before `firstClaimedAt` existed falls back to its lease, then its row.
 */
function firstClaimOf(row: ExportRow): Date {
  return row.firstClaimedAt ?? row.claimedAt ?? row.createdAt ?? new Date(0);
}

/**
 * #962 — a claim is in progress only while a run holds it and it is younger
 * than the TTL. Ownerless (kept after an ambiguous failure, or written before
 * claims carried an owner) or expired (its run died) means reconcile.
 */
function claimStateOf(row: ExportRow, now: number, ttl: number): "in_progress" | "reconcile" {
  if (row.claimRunId && row.claimedAt && now - new Date(row.claimedAt).getTime() < ttl) {
    return "in_progress";
  }
  return "reconcile";
}
/**
 * #953 — a live run must reproduce the dry run it was approved from. Refused
 * 409 when tasks.md has a newer version, or when the plan differs (a task was
 * exported meanwhile, the target moved). No expectation: nothing to compare.
 */
function assertPlanUnchanged(
  expected: TasksToIssuesInput["expectedPlan"],
  tasksVersion: number,
  planDigest: string,
): void {
  if (!expected) return;
  if (expected.tasksVersion !== tasksVersion) {
    throw new SpecKitArtifactError(
      409,
      "SPECKIT_EXPORT_PLAN_CHANGED",
      `tasks.md changed since the dry run (previewed version ${expected.tasksVersion}, now ${tasksVersion}). Run the dry run again and review the issues before publishing.`,
    );
  }
  if (expected.digest !== planDigest) {
    throw new SpecKitArtifactError(
      409,
      "SPECKIT_EXPORT_PLAN_CHANGED",
      "The issues this export would create differ from the dry run (a task was exported meanwhile, or the target changed). Run the dry run again and review the issues before publishing.",
    );
  }
}

/** GitHub refuses (422) a label name longer than this many characters. */
export const GITHUB_LABEL_MAX_LENGTH = 50;

/**
 * #988 — `prefix + value` as a GitHub label name, at most
 * {@link GITHUB_LABEL_MAX_LENGTH} characters. A name that fits is unchanged; a
 * longer one keeps the head of `value` and ends in a hash of the whole value,
 * so two long slugs sharing a head still get distinct labels. The full slug
 * stays in the issue body's `Source:` line.
 */
export function githubLabel(prefix: string, value: string): string {
  const full = `${prefix}${value}`;
  if ([...full].length <= GITHUB_LABEL_MAX_LENGTH) return full;
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  const room = GITHUB_LABEL_MAX_LENGTH - [...prefix].length - 1 - hash.length;
  const head = [...value].slice(0, room).join("").replace(/-+$/, "");
  return `${prefix}${head}-${hash}`;
}

/** GitHub refuses (422) an issue title longer than this many characters. */
export const GITHUB_TITLE_MAX_LENGTH = 256;

/**
 * #993 — `[<id>] <title>`, at most {@link GITHUB_TITLE_MAX_LENGTH} characters.
 * Titles are no longer cut at the first `(`, so a long task line could exceed
 * GitHub's limit; the full text is always in the body's `## Task` section.
 */
export function issueTitle(task: Pick<ParsedTask, "id" | "title">): string {
  const full = `[${task.id}] ${task.title}`;
  const chars = [...full];
  if (chars.length <= GITHUB_TITLE_MAX_LENGTH) return full;
  return `${chars
    .slice(0, GITHUB_TITLE_MAX_LENGTH - 1)
    .join("")
    .trimEnd()}…`;
}

export function renderIssueBody(task: ParsedTask, featureSlug: string): string {
  const lines: string[] = [];
  lines.push(`Source: specs/${featureSlug}/tasks.md#${task.id}`);
  lines.push("");
  lines.push(`Parallelizable: ${task.parallelizable ? "yes" : "no"}`);
  if (task.dependsOn.length > 0) {
    lines.push(`Depends on: ${task.dependsOn.join(", ")}`);
  }
  if (task.storyPoints !== null) lines.push(`Story Points: ${task.storyPoints}`);
  if (task.userStorySlug) lines.push(`User Story: ${task.userStorySlug}`);
  if (task.satisfies.length > 0) lines.push(`Satisfies: ${task.satisfies.join(", ")}`);
  // #993 — the task as written in tasks.md, so the issue carries its whole
  // description (file:line spans, acceptance) and not only its title.
  if (task.text) {
    lines.push("");
    lines.push("## Task");
    lines.push(task.text);
  }
  if (task.notes) {
    lines.push("");
    lines.push("## Notes");
    lines.push(task.notes);
  }
  if (task.files.length > 0) {
    lines.push("");
    lines.push("## Files");
    for (const f of task.files) lines.push(`- \`${f}\``);
  }
  lines.push("");
  return lines.join("\n");
}

function topoSort(tasks: ParsedTask[]): ParsedTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const out: ParsedTask[] = [];
  function visit(id: string, stack: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const cycle = [...stack.slice(stack.indexOf(id)), id].join(" -> ");
      throw new SpecKitArtifactError(
        400,
        "SPECKIT_TASKS_CYCLE",
        `tasks.md has a dependency cycle: ${cycle}`,
      );
    }
    const task = byId.get(id);
    if (!task) return;
    visiting.add(id);
    for (const dep of task.dependsOn) visit(dep, [...stack, id]);
    visiting.delete(id);
    visited.add(id);
    out.push(task);
  }
  for (const t of tasks) visit(t.id, []);
  return out;
}

/** The export target: SpecKitConfig, then the saved publish target (#733), then the env default. */
export async function resolveTasksExportRepo(
  projectId: string,
): Promise<{ owner: string; name: string }> {
  const cfg = await prisma.specKitConfig.findUnique({ where: { projectId } });
  if (cfg?.tasksToIssuesRepo) {
    const [owner, name] = cfg.tasksToIssuesRepo.split("/");
    if (owner && name) return { owner, name };
  }
  // #784 — the project's saved publish target (#733), read through the same
  // helper the finding publisher uses. Deliberately NOT the project's
  // RepoConnection: that is the analysed repository, which for an open-source
  // project is its upstream. A half-set pair counts as none.
  const saved = await findSavedGitHubTarget(projectId);
  if (saved) return { owner: saved.owner, name: saved.repo };
  const envRepo = process.env.SPECKIT_TASKS_DEFAULT_REPO;
  if (envRepo) {
    const [owner, name] = envRepo.split("/");
    if (owner && name) return { owner, name };
  }
  throw new SpecKitArtifactError(
    400,
    "SPECKIT_NO_REPO_CONFIGURED",
    "No GitHub repo resolvable for tasks export. Set repo=, configure SpecKitConfig.tasksToIssuesRepo, save a project publish target on the Publishing page, or set SPECKIT_TASKS_DEFAULT_REPO.",
  );
}

async function resolveParentEpic(projectId: string): Promise<number | null> {
  const cfg = await prisma.specKitConfig.findUnique({ where: { projectId } });
  return cfg?.tasksToIssuesParentEpic ?? null;
}

function warnSubIssueFailure(opts: {
  actorId: string | null;
  featureSlug: string;
  parent: number;
  child: number;
  err: unknown;
}): void {
  const message = opts.err instanceof Error ? opts.err.message : String(opts.err);
  // eslint-disable-next-line no-console
  console.warn(
    `[speckit.taskstoissues] addSubIssue failed for ${opts.featureSlug} (parent=${opts.parent}, child=${opts.child}): ${message}`,
  );
  audit({
    actor: opts.actorId ? { id: opts.actorId } : null,
    action: "speckit.subissue_link_failed",
    target: { type: "github_issue", id: String(opts.child) },
    metadata: {
      featureSlug: opts.featureSlug,
      parent: opts.parent,
      child: opts.child,
      error: message,
    },
  });
}
