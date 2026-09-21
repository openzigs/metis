/**
 * Monthly PDF chargeback report generator (Epic #47 / Issue #52).
 *
 * Builds a per-workspace cost breakdown by project AND by user for a calendar
 * month, including a prior-month comparison, renders it to markdown, then to a
 * PDF via the existing `docs-gen/exporters.ts` renderer, and (optionally)
 * emails it to each workspace owner via the #50 email channel.
 *
 * Data sources:
 *   - Per-project cost: `TokenUsage.costCents` aggregated by projectId.
 *   - Per-user cost:     `AITokenUsage.estimatedCostUsd` aggregated by userId
 *     (converted to integer cents for consistency).
 *
 * SECURITY: every user-controlled value (workspace/project name, username,
 * email) is HTML-escaped before it reaches the PDF renderer to prevent
 * injection into the generated HTML/PDF. `escapeMarkdownCell` also neutralises
 * markdown table-breaking characters.
 */
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import { exportDocument } from "../docs-gen/exporters.js";
import { resolveEmailSender, type EmailSender } from "./channels/email-sender.js";

const log = createChildLogger("finops-chargeback");

export interface MonthRange {
  start: Date;
  end: Date;
  label: string; // e.g. "2026-05"
}

/** Compute the calendar-month range for the month that `now` falls within,
 *  shifted back by `monthsAgo` months (0 = current month). */
export function monthRange(now: Date, monthsAgo = 0): MonthRange {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo + 1, 1));
  const label = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
  return { start, end, label };
}

export interface CostLine {
  id: string;
  name: string;
  costCents: number;
}

export interface ChargebackData {
  workspaceId: string;
  workspaceName: string;
  current: MonthRange;
  prior: MonthRange;
  totalCurrentCents: number;
  totalPriorCents: number;
  byProject: CostLine[];
  byUser: CostLine[];
}

function usdToCents(usd: number | null | undefined): number {
  if (!usd || !Number.isFinite(usd)) return 0;
  return Math.round(usd * 100);
}

/** Aggregate per-project cost (cents) for a workspace over a window. */
async function projectCosts(workspaceId: string, range: MonthRange): Promise<CostLine[]> {
  const projects = await prisma.project.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true, name: true },
  });
  if (projects.length === 0) return [];
  const nameById = new Map(projects.map((p) => [p.id, p.name]));

  // N1: single grouped aggregate instead of one query per project — mirrors
  // the `userCosts` pattern below.
  const grouped = await prisma.tokenUsage.groupBy({
    by: ["projectId"],
    where: {
      projectId: { in: projects.map((p) => p.id) },
      createdAt: { gte: range.start, lt: range.end },
    },
    _sum: { costCents: true },
  });

  return grouped
    .map((g) => ({
      id: g.projectId,
      name: nameById.get(g.projectId) ?? g.projectId,
      costCents: g._sum.costCents ?? 0,
    }))
    .filter((l) => l.costCents > 0)
    .sort((a, b) => b.costCents - a.costCents);
}

/** Aggregate per-user cost (cents) for a workspace's projects over a window. */
async function userCosts(workspaceId: string, range: MonthRange): Promise<CostLine[]> {
  const projects = await prisma.project.findMany({
    where: { workspaceId, deletedAt: null },
    select: { id: true },
  });
  const projectIds = projects.map((p) => p.id);
  if (projectIds.length === 0) return [];

  const rows = await prisma.aITokenUsage.findMany({
    where: {
      projectId: { in: projectIds },
      ts: { gte: range.start, lt: range.end },
    },
    select: { userId: true, estimatedCostUsd: true },
  });
  const byUser = new Map<string, number>();
  for (const r of rows) {
    byUser.set(r.userId, (byUser.get(r.userId) ?? 0) + usdToCents(r.estimatedCostUsd));
  }
  const userIds = [...byUser.keys()];
  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: { id: true, displayName: true, username: true },
  });
  const nameById = new Map(users.map((u) => [u.id, u.displayName || u.username]));
  return [...byUser.entries()]
    .map(([id, costCents]) => ({ id, name: nameById.get(id) ?? id, costCents }))
    .filter((l) => l.costCents > 0)
    .sort((a, b) => b.costCents - a.costCents);
}

/** Gather all chargeback data for a workspace for the prior calendar month. */
export async function gatherChargebackData(
  workspaceId: string,
  now: Date = new Date(),
): Promise<ChargebackData | null> {
  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: { id: true, name: true },
  });
  if (!workspace) return null;

  // The "report month" is the month that just closed (monthsAgo = 1) when run
  // on the 1st; prior comparison is the month before that.
  const current = monthRange(now, 1);
  const prior = monthRange(now, 2);

  const [byProject, byUser, priorProjects] = await Promise.all([
    projectCosts(workspaceId, current),
    userCosts(workspaceId, current),
    projectCosts(workspaceId, prior),
  ]);

  return {
    workspaceId,
    workspaceName: workspace.name,
    current,
    prior,
    totalCurrentCents: byProject.reduce((s, l) => s + l.costCents, 0),
    totalPriorCents: priorProjects.reduce((s, l) => s + l.costCents, 0),
    byProject,
    byUser,
  };
}

function fmtCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Escape a value destined for a markdown table cell (and downstream HTML). */
export function escapeMarkdownCell(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n]+/g, " ")
    .trim();
}

function pctChange(currentCents: number, priorCents: number): string {
  if (priorCents === 0) return currentCents === 0 ? "0%" : "new";
  const change = ((currentCents - priorCents) / priorCents) * 100;
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(1)}%`;
}

/** Render the chargeback data to a markdown document. */
export function renderChargebackMarkdown(data: ChargebackData): string {
  const lines: string[] = [];
  lines.push(`# Chargeback Report — ${escapeMarkdownCell(data.workspaceName)}`);
  lines.push("");
  lines.push(`**Billing period:** ${data.current.label}`);
  lines.push("");
  lines.push(
    `**Total spend:** ${fmtCents(data.totalCurrentCents)} ` +
      `(prior month ${data.prior.label}: ${fmtCents(data.totalPriorCents)}, ` +
      `${pctChange(data.totalCurrentCents, data.totalPriorCents)})`,
  );
  lines.push("");

  lines.push("## Cost by Project");
  lines.push("");
  if (data.byProject.length === 0) {
    lines.push("_No project spend recorded this period._");
  } else {
    lines.push("| Project | Cost |");
    lines.push("| --- | --- |");
    for (const p of data.byProject) {
      lines.push(`| ${escapeMarkdownCell(p.name)} | ${fmtCents(p.costCents)} |`);
    }
  }
  lines.push("");

  lines.push("## Cost by User");
  lines.push("");
  if (data.byUser.length === 0) {
    lines.push("_No per-user spend recorded this period._");
  } else {
    lines.push("| User | Cost |");
    lines.push("| --- | --- |");
    for (const u of data.byUser) {
      lines.push(`| ${escapeMarkdownCell(u.name)} | ${fmtCents(u.costCents)} |`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export interface ChargebackReport {
  workspaceId: string;
  workspaceName: string;
  period: string;
  markdown: string;
  pdf: Buffer;
  filename: string;
  mimeType: string;
}

/** Build the chargeback PDF for a workspace. Returns null when the workspace
 *  is unknown. */
export async function buildChargebackReport(
  workspaceId: string,
  now: Date = new Date(),
): Promise<ChargebackReport | null> {
  const data = await gatherChargebackData(workspaceId, now);
  if (!data) return null;
  const markdown = renderChargebackMarkdown(data);
  const title = `Chargeback ${data.workspaceName} ${data.current.label}`;
  const exported = await exportDocument(markdown, title, "pdf");
  return {
    workspaceId,
    workspaceName: data.workspaceName,
    period: data.current.label,
    markdown,
    pdf: exported.buffer,
    filename: exported.filename,
    mimeType: exported.mimeType,
  };
}

/** Workspace owners are members with role "owner". */
async function workspaceOwnerEmails(workspaceId: string): Promise<string[]> {
  const members = await prisma.workspaceMember.findMany({
    where: { workspaceId, role: "owner" },
    select: { user: { select: { email: true } } },
  });
  return members.map((m) => m.user.email).filter((e): e is string => Boolean(e));
}

export interface GenerateAndSendOptions {
  emailSender?: EmailSender;
}

/**
 * Build the chargeback report and email it (with the PDF attached) to every
 * workspace owner. Returns the number of owners emailed. Best-effort: an email
 * failure is logged but does not throw.
 */
export async function generateAndSendChargeback(
  workspaceId: string,
  now: Date = new Date(),
  opts: GenerateAndSendOptions = {},
): Promise<{ sent: number; report: ChargebackReport | null }> {
  const report = await buildChargebackReport(workspaceId, now);
  if (!report) return { sent: 0, report: null };

  const emailSender = opts.emailSender ?? resolveEmailSender();
  const owners = await workspaceOwnerEmails(workspaceId);
  let sent = 0;
  for (const to of owners) {
    const r = await emailSender.send({
      to,
      subject: `[METIS] Chargeback report — ${report.workspaceName} (${report.period})`,
      text:
        `Attached is the ${report.period} chargeback report for workspace ` +
        `"${report.workspaceName}".`,
      attachments: [
        { filename: report.filename, content: report.pdf, contentType: report.mimeType },
      ],
    });
    if (r.ok) sent += 1;
    else log.warn("chargeback email failed", { workspaceId, to, error: r.error });
  }
  return { sent, report };
}

/**
 * Run chargeback generation for every workspace. Invoked by the monthly cron
 * (`0 6 1 * *`). Errors per-workspace are swallowed.
 */
export async function runMonthlyChargeback(
  now: Date = new Date(),
  opts: GenerateAndSendOptions = {},
): Promise<{ workspaces: number; emailsSent: number }> {
  const workspaces = await prisma.workspace.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });
  let emailsSent = 0;
  for (const ws of workspaces) {
    try {
      const { sent } = await generateAndSendChargeback(ws.id, now, opts);
      emailsSent += sent;
    } catch (err) {
      log.warn("chargeback run failed", { workspaceId: ws.id, error: (err as Error).message });
    }
  }
  log.info("monthly chargeback complete", { workspaces: workspaces.length, emailsSent });
  return { workspaces: workspaces.length, emailsSent };
}
