/**
 * Unit tests for the monthly chargeback report generator (Epic #47 / Issue
 * #52). Mocks Prisma + the PDF exporter. Covers project/user breakdown,
 * prior-month comparison, HTML/markdown escaping (injection AC), owner
 * emailing, and the cron schedule (0 6 1 * *).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const projects: Array<{ id: string; name: string; workspaceId: string; deletedAt: Date | null }> =
  [];
const tokenUsage: Array<{ projectId: string; costCents: number; createdAt: Date }> = [];
const aiUsage: Array<{
  projectId: string | null;
  userId: string;
  estimatedCostUsd: number | null;
  ts: Date;
}> = [];
const users: Array<{ id: string; displayName: string; username: string }> = [];
const workspaces: Array<{ id: string; name: string; deletedAt: Date | null }> = [];
const members: Array<{ workspaceId: string; role: string; user: { email: string } }> = [];

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    workspace: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          workspaces.find((w) => w.id === where.id) ?? null,
      ),
      findMany: vi.fn(async () => workspaces.filter((w) => w.deletedAt === null)),
    },
    project: {
      findMany: vi.fn(async ({ where }: { where: { workspaceId: string } }) =>
        projects.filter((p) => p.workspaceId === where.workspaceId && p.deletedAt === null),
      ),
    },
    tokenUsage: {
      // N1: chargeback now aggregates per-project cost with a single groupBy
      // instead of one findMany per project.
      groupBy: vi.fn(
        async ({
          where,
        }: {
          where: { projectId: { in: string[] }; createdAt: { gte: Date; lt: Date } };
        }) => {
          const sums = new Map<string, number>();
          for (const r of tokenUsage) {
            if (
              where.projectId.in.includes(r.projectId) &&
              r.createdAt >= where.createdAt.gte &&
              r.createdAt < where.createdAt.lt
            ) {
              sums.set(r.projectId, (sums.get(r.projectId) ?? 0) + r.costCents);
            }
          }
          return [...sums.entries()].map(([projectId, costCents]) => ({
            projectId,
            _sum: { costCents },
          }));
        },
      ),
    },
    aITokenUsage: {
      findMany: vi.fn(
        async ({
          where,
        }: {
          where: { projectId: { in: string[] }; ts: { gte: Date; lt: Date } };
        }) =>
          aiUsage.filter(
            (r) =>
              r.projectId !== null &&
              where.projectId.in.includes(r.projectId) &&
              r.ts >= where.ts.gte &&
              r.ts < where.ts.lt,
          ),
      ),
    },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        users.filter((u) => where.id.in.includes(u.id)),
      ),
    },
    workspaceMember: {
      findMany: vi.fn(async ({ where }: { where: { workspaceId: string; role: string } }) =>
        members.filter((m) => m.workspaceId === where.workspaceId && m.role === where.role),
      ),
    },
  },
}));

vi.mock("../src/lib/docs-gen/exporters.js", () => ({
  exportDocument: vi.fn(async (_md: string, title: string) => ({
    buffer: Buffer.from("%PDF-1.4 fake"),
    mimeType: "application/pdf",
    filename: `${title}.pdf`,
  })),
}));

import {
  buildChargebackReport,
  escapeMarkdownCell,
  gatherChargebackData,
  generateAndSendChargeback,
  monthRange,
  renderChargebackMarkdown,
  runMonthlyChargeback,
} from "../src/lib/finops/chargeback-report.js";
import { exportDocument } from "../src/lib/docs-gen/exporters.js";

const exportDocumentMock = exportDocument as unknown as ReturnType<typeof vi.fn>;

// Run on 1 July 2026 → report month = June (2026-06), prior = May (2026-05).
const NOW = new Date(Date.UTC(2026, 6, 1, 6, 0, 0));

beforeEach(() => {
  projects.length = 0;
  tokenUsage.length = 0;
  aiUsage.length = 0;
  users.length = 0;
  workspaces.length = 0;
  members.length = 0;
  exportDocumentMock.mockClear();
});

describe("monthRange", () => {
  it("computes the prior calendar month range when run on the 1st", () => {
    const r = monthRange(NOW, 1);
    expect(r.label).toBe("2026-06");
    expect(r.start.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("computes two months ago for the comparison window", () => {
    expect(monthRange(NOW, 2).label).toBe("2026-05");
  });
});

describe("escapeMarkdownCell (injection defence)", () => {
  it("neutralises HTML tags and table-breaking pipes/newlines", () => {
    const escaped = escapeMarkdownCell("<script>alert(1)</script> | evil\nrow");
    expect(escaped).not.toContain("<script>");
    expect(escaped).toContain("&lt;script&gt;");
    expect(escaped).toContain("\\|");
    expect(escaped).not.toContain("\n");
  });

  it("escapes ampersands so entities are not double-decoded (Mi3)", () => {
    expect(escapeMarkdownCell("Tom & Jerry")).toBe("Tom &amp; Jerry");
    // & must be escaped BEFORE < so the &lt; entity's own & is not re-escaped.
    expect(escapeMarkdownCell("a<b")).toBe("a&lt;b");
    expect(escapeMarkdownCell("x & <y>")).toBe("x &amp; &lt;y&gt;");
  });
});

describe("gatherChargebackData", () => {
  it("aggregates per-project and per-user cost with prior comparison", async () => {
    workspaces.push({ id: "w1", name: "Acme", deletedAt: null });
    projects.push(
      { id: "p1", name: "Alpha", workspaceId: "w1", deletedAt: null },
      { id: "p2", name: "Beta", workspaceId: "w1", deletedAt: null },
    );
    // June (report month) usage.
    tokenUsage.push(
      { projectId: "p1", costCents: 3_000, createdAt: new Date(Date.UTC(2026, 5, 10)) },
      { projectId: "p2", costCents: 1_000, createdAt: new Date(Date.UTC(2026, 5, 12)) },
    );
    // May (prior month) usage.
    tokenUsage.push({
      projectId: "p1",
      costCents: 2_000,
      createdAt: new Date(Date.UTC(2026, 4, 10)),
    });
    // Per-user usage (June).
    aiUsage.push(
      { projectId: "p1", userId: "u1", estimatedCostUsd: 20, ts: new Date(Date.UTC(2026, 5, 10)) },
      { projectId: "p2", userId: "u2", estimatedCostUsd: 5, ts: new Date(Date.UTC(2026, 5, 12)) },
    );
    users.push(
      { id: "u1", displayName: "Alice", username: "alice" },
      { id: "u2", displayName: "Bob", username: "bob" },
    );

    const data = await gatherChargebackData("w1", NOW);
    expect(data).not.toBeNull();
    expect(data?.totalCurrentCents).toBe(4_000);
    expect(data?.totalPriorCents).toBe(2_000);
    expect(data?.byProject.map((p) => p.name)).toEqual(["Alpha", "Beta"]);
    expect(data?.byUser.find((u) => u.name === "Alice")?.costCents).toBe(2_000);
  });

  it("returns null for an unknown workspace", async () => {
    expect(await gatherChargebackData("missing", NOW)).toBeNull();
  });
});

describe("renderChargebackMarkdown", () => {
  it("renders breakdown tables, totals, and a prior-month comparison", () => {
    const md = renderChargebackMarkdown({
      workspaceId: "w1",
      workspaceName: "Acme",
      current: monthRange(NOW, 1),
      prior: monthRange(NOW, 2),
      totalCurrentCents: 4_000,
      totalPriorCents: 2_000,
      byProject: [{ id: "p1", name: "Alpha", costCents: 4_000 }],
      byUser: [{ id: "u1", name: "Alice", costCents: 4_000 }],
    });
    expect(md).toContain("# Chargeback Report — Acme");
    expect(md).toContain("2026-06");
    expect(md).toContain("$40.00");
    expect(md).toContain("+100.0%"); // 2000 -> 4000
    expect(md).toContain("## Cost by Project");
    expect(md).toContain("## Cost by User");
    expect(md).toContain("| Alpha | $40.00 |");
  });

  it("escapes a malicious project name in the rendered table", () => {
    const md = renderChargebackMarkdown({
      workspaceId: "w1",
      workspaceName: "Acme",
      current: monthRange(NOW, 1),
      prior: monthRange(NOW, 2),
      totalCurrentCents: 100,
      totalPriorCents: 0,
      byProject: [{ id: "p1", name: "<img src=x onerror=alert(1)>", costCents: 100 }],
      byUser: [],
    });
    expect(md).not.toContain("<img");
    expect(md).toContain("&lt;img");
  });
});

describe("buildChargebackReport", () => {
  it("builds a PDF via the exporter", async () => {
    workspaces.push({ id: "w1", name: "Acme", deletedAt: null });
    const report = await buildChargebackReport("w1", NOW);
    expect(report?.mimeType).toBe("application/pdf");
    expect(report?.period).toBe("2026-06");
    expect(exportDocumentMock).toHaveBeenCalledWith(expect.any(String), expect.any(String), "pdf");
  });
});

describe("generateAndSendChargeback", () => {
  it("emails the PDF to every workspace owner", async () => {
    workspaces.push({ id: "w1", name: "Acme", deletedAt: null });
    members.push(
      { workspaceId: "w1", role: "owner", user: { email: "owner1@acme.com" } },
      { workspaceId: "w1", role: "owner", user: { email: "owner2@acme.com" } },
    );
    const send = vi.fn(async () => ({ ok: true }));
    const { sent } = await generateAndSendChargeback("w1", NOW, { emailSender: { send } });
    expect(sent).toBe(2);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "owner1@acme.com",
        attachments: expect.arrayContaining([
          expect.objectContaining({ contentType: "application/pdf" }),
        ]),
      }),
    );
  });
});

describe("runMonthlyChargeback", () => {
  it("iterates every workspace and totals emails sent", async () => {
    workspaces.push(
      { id: "w1", name: "Acme", deletedAt: null },
      { id: "w2", name: "Globex", deletedAt: null },
    );
    members.push({ workspaceId: "w1", role: "owner", user: { email: "a@acme.com" } });
    const send = vi.fn(async () => ({ ok: true }));
    const res = await runMonthlyChargeback(NOW, { emailSender: { send } });
    expect(res.workspaces).toBe(2);
    expect(res.emailsSent).toBe(1);
  });
});
