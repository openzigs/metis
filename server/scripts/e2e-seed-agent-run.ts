/**
 * Epic #158 — seed a single AgentRun + AgentRunStep rows directly into the
 * e2e SQLite database so the /runs and /runs/:id pages have something to
 * render without booting the full multi-agent pipeline.
 *
 * Usage:
 *   tsx server/scripts/e2e-seed-agent-run.ts <projectId>
 *
 * Writes the new run id to stdout as JSON: `{"id":"run_xxx"}`.
 */
/* eslint-disable no-console */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

async function main(): Promise<void> {
  const [projectId] = process.argv.slice(2);
  if (!projectId) {
    console.error("usage: e2e-seed-agent-run.ts <projectId>");
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set");
    process.exit(2);
  }

  // Prisma 7 dropped `datasources`; the SQLite driver adapter is the
  // supported way to point a client at the e2e database file.
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  try {
    const id = `run_${randomUUID()}`;
    const now = new Date();
    await prisma.agentRun.create({
      data: {
        id,
        sessionId: `session_${randomUUID()}`,
        projectId,
        kind: "analysis",
        startedAt: new Date(now.getTime() - 1500),
        completedAt: now,
        latencyMs: 1500,
        totalTokens: 250,
        costCents: 3,
        status: "completed",
      },
    });
    await prisma.agentRunStep.createMany({
      data: [
        {
          runId: id,
          ord: 0,
          kind: "agent_phase",
          content: JSON.stringify({ agentKey: "document", phase: "start" }),
          spanId: null,
          traceId: null,
          latencyMs: 50,
        },
        {
          runId: id,
          ord: 1,
          kind: "tool_call",
          content: JSON.stringify({ tool: "browser_verify", args: { url: "https://example.com" } }),
          spanId: null,
          traceId: null,
          latencyMs: 700,
        },
        {
          runId: id,
          ord: 2,
          kind: "synthesis",
          content: JSON.stringify({ summary: "deterministic synthesis output" }),
          spanId: null,
          traceId: null,
          latencyMs: 750,
        },
      ],
    });
    console.log(JSON.stringify({ id }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
