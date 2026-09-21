/**
 * Epic #396 (MVP-4) — `/speckit.taskstoissues` command.
 *
 * Parses the feature's `tasks.md` and creates one GitHub issue per row,
 * tagged with the user-story slug, with `Parallelizable: yes/no`, the
 * referenced files, and `Source: specs/<slug>/tasks.md#T<NN>` for
 * traceability. Re-exports upsert by `(featureSlug, taskId)`.
 *
 * Issue creation goes through a pluggable `IssueClient` so the command is
 * fully testable without a live GitHub. The default client uses the
 * GitHub REST API with a token from the per-project `RepoConnection` (or
 * the env fallback `SPECKIT_TASKS_DEFAULT_REPO` + `GITHUB_TOKEN`).
 */
import { prisma } from "../../prisma.js";
import { audit } from "../../audit/audit-service.js";
import { resolveFeatureBySlug } from "../features.js";
import { getFeatureArtifact } from "../feature-artifacts.js";
import { requireGate } from "../gates.js";
import { parseTasksMarkdown, type ParsedTask } from "../tasks-parser.js";
import { SpecKitArtifactError } from "../artifacts.js";

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
  /** Override resolved repo. Required if no RepoConnection / config exists. */
  repo?: { owner: string; name: string };
  /** Override parent epic. Falls back to `SpecKitConfig.tasksToIssuesParentEpic`. */
  parentEpicNumber?: number;
  /** Pluggable issue client (defaults to `noopIssueClient` for safety). */
  client?: IssueClient;
  actorId?: string | null;
  /** When true, parses + plans only — no GitHub calls, no DB writes. */
  dryRun?: boolean;
  /** Bypass the tasksGate (audit-emitted high-severity event). */
  force?: boolean;
}

export interface TasksToIssuesResult {
  count: number;
  created: Array<{ taskId: string; issueNumber: number; url: string; upserted: boolean }>;
  repo: { owner: string; name: string };
  parentEpicNumber: number | null;
  message: string;
}

export const noopIssueClient: IssueClient = {
  async create(_o, _n, req) {
    return { number: 0, url: `dryrun://${encodeURIComponent(req.title)}` };
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
    throw new SpecKitArtifactError(
      412,
      "SPECKIT_GATE_UNMET",
      "tasks.md is required — run /speckit.tasks first",
    );
  }
  const tasks = parseTasksMarkdown(tasksArt.content);
  if (tasks.length === 0) {
    return {
      count: 0,
      created: [],
      repo: input.repo ?? { owner: "", name: "" },
      parentEpicNumber: input.parentEpicNumber ?? null,
      message: "No tasks found in tasks.md.",
    };
  }

  const repo = input.repo ?? (await resolveRepo(input.projectId));
  const parentEpicNumber = input.parentEpicNumber ?? (await resolveParentEpic(input.projectId));
  const client = input.client ?? noopIssueClient;
  const created: TasksToIssuesResult["created"] = [];

  // Topologically iterate so deps are created before children.
  const ordered = topoSort(tasks);
  const idToIssueNumber = new Map<string, number>();

  for (const task of ordered) {
    const upsertKey = {
      projectId_featureSlug_taskId: {
        projectId: input.projectId,
        featureSlug: feature.slug,
        taskId: task.id,
      },
    };
    const existing = input.dryRun
      ? null
      : await prisma.specKitTaskExport.findUnique({ where: upsertKey });

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
      const resp = await client.create(repo.owner, repo.name, {
        title: `[${task.id}] ${task.title}`,
        body,
        labels,
      });
      issueNumber = resp.number;
      url = resp.url;
      if (!input.dryRun) {
        await prisma.specKitTaskExport.create({
          data: {
            projectId: input.projectId,
            featureSlug: feature.slug,
            taskId: task.id,
            issueNumber,
            repoOwner: repo.owner,
            repoName: repo.name,
          },
        });
      }
    }
    idToIssueNumber.set(task.id, issueNumber);

    // Link sub-issues to parent epic if supported.
    if (parentEpicNumber !== null && client.addSubIssue && !input.dryRun && !wasUpsert) {
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
    if (client.addSubIssue && !input.dryRun) {
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
    created.push({ taskId: task.id, issueNumber, url, upserted: wasUpsert });
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
    },
  });

  return {
    count: created.length,
    created,
    repo,
    parentEpicNumber,
    message: `Exported ${created.length} task(s) to ${repo.owner}/${repo.name}.`,
  };
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

async function resolveRepo(projectId: string): Promise<{ owner: string; name: string }> {
  const cfg = await prisma.specKitConfig.findUnique({ where: { projectId } });
  if (cfg?.tasksToIssuesRepo) {
    const [owner, name] = cfg.tasksToIssuesRepo.split("/");
    if (owner && name) return { owner, name };
  }
  const conn = await prisma.repoConnection.findFirst({
    where: { projectId, deletedAt: null },
    select: { ownerOrOrg: true, repoName: true },
  });
  // Issue #288 — skip local/upload connectors (no owner/repo to publish to).
  if (conn?.ownerOrOrg && conn.repoName) return { owner: conn.ownerOrOrg, name: conn.repoName };
  const envRepo = process.env.SPECKIT_TASKS_DEFAULT_REPO;
  if (envRepo) {
    const [owner, name] = envRepo.split("/");
    if (owner && name) return { owner, name };
  }
  throw new SpecKitArtifactError(
    400,
    "SPECKIT_NO_REPO_CONFIGURED",
    "No GitHub repo resolvable for tasks export. Set repo=, configure SpecKitConfig.tasksToIssuesRepo, attach a RepoConnection, or set SPECKIT_TASKS_DEFAULT_REPO.",
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
