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
import { createHash } from "node:crypto";
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
  }>;
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
  /** The epic new issues are linked under; a different one is a different plan. */
  parentEpicNumber?: number | null;
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
  const feature = await resolveFeatureBySlug(input.projectId, input.featureSlug);
  if (!feature) {
    throw new SpecKitArtifactError(
      404,
      "SPECKIT_FEATURE_NOT_FOUND",
      `Feature not found: ${input.featureSlug}`,
    );
  }
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
  const tasks = parseTasksMarkdown(tasksArt.content);
  const publishAvailable = input.publishAvailable ?? Boolean(input.client);
  const tasksVersion = tasksArt.version;
  if (tasks.length === 0) {
    const repo = input.repo ?? { owner: "", name: "" };
    return {
      count: 0,
      created: [],
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
  const created: TasksToIssuesResult["created"] = [];

  // Topologically iterate so deps are created before children. #953 — the
  // whole plan (what already exists, what would be created) is read before
  // any issue is, so a dry run reports the same plan a live run executes and a
  // live run can be checked against it up front. Reading the export rows is
  // not a write: a dry run still persists nothing.
  const plan: Array<{ task: ParsedTask; title: string; existing: ExportRow | null }> = [];
  for (const task of topoSort(tasks)) {
    const existing = await prisma.specKitTaskExport.findUnique({
      where: {
        projectId_featureSlug_taskId: {
          projectId: input.projectId,
          featureSlug: feature.slug,
          taskId: task.id,
        },
      },
    });
    // #953 — issueNumber 0 is another live run's claim, not an exported issue.
    // A live run refuses rather than race it; a dry run plans the task as new.
    if (existing?.issueNumber === 0) {
      if (input.client && !input.dryRun) {
        throw new SpecKitArtifactError(
          409,
          "SPECKIT_EXPORT_IN_PROGRESS",
          "Another export of this feature is in progress. Wait for it to finish, then preview again.",
        );
      }
      plan.push({ task, title: `[${task.id}] ${task.title}`, existing: null });
      continue;
    }
    plan.push({ task, title: `[${task.id}] ${task.title}`, existing });
  }
  const toCreate = plan.filter((p) => !p.existing).map((p) => p.title);
  const planDigest = computePlanDigest({
    projectId: input.projectId,
    featureSlug: feature.slug,
    tasksVersion,
    repo,
    titles: toCreate,
    parentEpicNumber,
  });
  if (client) {
    assertPlanUnchanged(input.expectedPlan, tasksVersion, planDigest);
    if (input.maxCreates !== undefined && toCreate.length > input.maxCreates) {
      throw new SpecKitArtifactError(
        422,
        "SPECKIT_EXPORT_TOO_LARGE",
        `This export would create ${toCreate.length} issues; one export may create at most ${input.maxCreates}. Split the feature's tasks into smaller features to publish them.`,
      );
    }
  }
  const idToIssueNumber = new Map<string, number>();

  const exportOne = async ({
    task,
    title,
    existing,
  }: {
    task: ParsedTask;
    title: string;
    existing: ExportRow | null;
  }): Promise<TasksToIssuesResult["created"][number]> => {
    let issueNumber: number;
    let url: string;
    let wasUpsert = false;
    if (existing) {
      issueNumber = existing.issueNumber;
      url = `https://github.com/${existing.repoOwner}/${existing.repoName}/issues/${issueNumber}`;
      wasUpsert = true;
    } else {
      const body = renderIssueBody(task, feature.slug);
      const labels = [`speckit:${feature.slug}`];
      if (task.userStorySlug) labels.push(`story:${task.userStorySlug}`);
      const rowKey = {
        projectId_featureSlug_taskId: {
          projectId: input.projectId,
          featureSlug: feature.slug,
          taskId: task.id,
        },
      };
      if (client) {
        // #953 — claim the task BEFORE calling GitHub: the unique row lets
        // exactly one concurrent run create it, so no issue is filed twice or
        // left unrecorded. issueNumber 0 marks the claim until GitHub answers.
        try {
          await prisma.specKitTaskExport.create({
            data: {
              projectId: input.projectId,
              featureSlug: feature.slug,
              taskId: task.id,
              issueNumber: 0,
              repoOwner: repo.owner,
              repoName: repo.name,
            },
          });
        } catch (err) {
          if ((err as { code?: string }).code === "P2002") {
            throw new SpecKitArtifactError(
              409,
              "SPECKIT_EXPORT_IN_PROGRESS",
              "Another export of this feature is in progress. Wait for it to finish, then preview again.",
            );
          }
          throw err;
        }
      }
      let resp: { number: number; url: string };
      try {
        resp = client
          ? await client.create(repo.owner, repo.name, { title, body, labels })
          : plannedIssue(title);
      } catch (err) {
        // Nothing was created: release the claim so a retry can create it.
        if (client) await prisma.specKitTaskExport.delete({ where: rowKey });
        throw err;
      }
      issueNumber = resp.number;
      url = resp.url;
      if (client) {
        await prisma.specKitTaskExport.update({ where: rowKey, data: { issueNumber } });
      }
    }
    idToIssueNumber.set(task.id, issueNumber);

    // Link sub-issues to parent epic if supported.
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
    return { taskId: task.id, title, issueNumber, url, upserted: wasUpsert };
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
      created: created.filter((c) => !c.upserted).length,
    },
  });

  return {
    count: created.length,
    created,
    repo,
    parentEpicNumber,
    publishAvailable,
    tasksVersion,
    planDigest,
    message: `${input.dryRun ? "Would export" : "Exported"} ${created.length} task(s) to ${repo.owner}/${repo.name}.`,
  };
}

interface ExportRow {
  issueNumber: number;
  repoOwner: string;
  repoName: string;
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
