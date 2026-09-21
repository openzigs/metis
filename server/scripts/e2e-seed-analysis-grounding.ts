/**
 * Seed a completed Analysis with requirement-grounded findings directly into
 * the e2e SQLite database (Epic #912 / sub-issue #920).
 *
 * Why this exists: the requirement-grounded code agent only emits grounded
 * findings, requirement-gap findings, and filename-bearing citations when the
 * AI provider returns structured JSON. The deterministic e2e harness runs the
 * `offline-stub` provider, which returns hash-derived *prose* — so
 * `runRequirementGroundedCodeAgent` rejects the response as non-JSON and the
 * analysis completes with zero findings. None of the #920 UI states
 * ("Grounded in REQ-…", "Gap for REQ-…", filename + excerpt citations, the
 * empty-context info note) are therefore reachable through a live offline run.
 *
 * Rather than ship a "produce structured findings when AI_OFFLINE=1" hack into
 * the production stub, this script injects a finished Analysis snapshot so the
 * e2e spec can assert the **UI rendering** of grounding transparency (#920)
 * deterministically. It mirrors the existing `e2e-seed-requirement.ts` /
 * `e2e-seed-document.ts` pattern and reads PrismaClient from the server
 * package so it matches the runtime schema exactly.
 *
 * The finding shapes below are kept in lock-step with the constants exported
 * from `e2e/fixtures/grounding-fixture.ts` (the spec asserts against them).
 *
 * Usage:
 *   tsx server/scripts/e2e-seed-analysis-grounding.ts <projectId> <startedById>
 */
/* eslint-disable no-console -- this is a CLI script that writes to stdout/stderr */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";

// ── Deterministic fixture (mirrored in e2e/fixtures/grounding-fixture.ts) ────
const REQ_GROUNDED = "REQ-001";
const REQ_GAP = "REQ-002";

const GROUNDED_TITLE = "Password reset flow lacks rate limiting";
const GROUNDED_FILENAME = "auth-spec.md";
const GROUNDED_SNIPPET = "resetPassword(token) updates the credential store";

const GAP_TITLE = "No grounded evidence for REQ-002";

const PLAIN_TITLE = "Service layer mixes transport and domain concerns";
const PLAIN_FILENAME = "architecture-notes.md";
const PLAIN_SNIPPET = "ProjectController calls prisma directly";

function evidence(input: {
  citations: Array<{ documentId: string; chunkIndex: number; filename?: string; snippet?: string }>;
  tags: string[];
  requirementId: string | null;
}): string {
  return JSON.stringify(input);
}

async function main(): Promise<void> {
  const [projectId, startedById] = process.argv.slice(2);
  if (!projectId || !startedById) {
    console.error("usage: e2e-seed-analysis-grounding.ts <projectId> <startedById>");
    process.exit(2);
  }

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL must be set");
    process.exit(2);
  }

  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });
  try {
    const now = new Date();
    const analysis = await prisma.analysis.create({
      data: {
        projectId,
        startedById,
        status: "completed",
        startedAt: now,
        completedAt: now,
        totalTokens: 1234,
        metadata: JSON.stringify({ source: "e2e-seed-analysis-grounding" }),
      },
    });

    const agentResult = await prisma.agentResult.create({
      data: {
        analysisId: analysis.id,
        agentKey: "code",
        status: "completed",
        startedAt: now,
        completedAt: now,
        output: JSON.stringify({
          agentKey: "code",
          summary: "Requirement-grounded review (e2e seed).",
          findings: [],
          notes: [],
        }),
      },
    });

    // 1) Grounded finding — traces to REQ-001, carries a filename + excerpt.
    await prisma.finding.create({
      data: {
        agentResultId: agentResult.id,
        category: "architecture",
        severity: "high",
        title: GROUNDED_TITLE,
        body: "resetPassword(token) exists but no throttling guards the endpoint.",
        derivation: "inferred",
        confidence: 0.7,
        evidence: evidence({
          citations: [
            {
              documentId: "doc-seeded-grounding",
              chunkIndex: 2,
              filename: GROUNDED_FILENAME,
              snippet: GROUNDED_SNIPPET,
            },
          ],
          tags: ["gap"],
          requirementId: REQ_GROUNDED,
        }),
      },
    });

    // 2) Requirement-gap finding — severity=info + requirement-gap tag, no
    //    citations → distinct amber styling + the empty-context note.
    await prisma.finding.create({
      data: {
        agentResultId: agentResult.id,
        category: "other",
        severity: "info",
        title: GAP_TITLE,
        body: `No supporting evidence was retrieved from the selected documents for requirement ${REQ_GAP}. This gap requires manual review.`,
        derivation: "inferred",
        confidence: 0.7,
        evidence: evidence({
          citations: [],
          tags: ["requirement-gap"],
          requirementId: REQ_GAP,
        }),
      },
    });

    // 3) Plain specialist finding — no requirement linkage → renders no badge,
    //    but still surfaces a filename-bearing citation.
    await prisma.finding.create({
      data: {
        agentResultId: agentResult.id,
        category: "architecture",
        severity: "medium",
        title: PLAIN_TITLE,
        body: "Controllers reach into the data layer directly, coupling transport to persistence.",
        derivation: "inferred",
        confidence: 0.7,
        evidence: evidence({
          citations: [
            {
              documentId: "doc-seeded-plain",
              chunkIndex: 0,
              filename: PLAIN_FILENAME,
              snippet: PLAIN_SNIPPET,
            },
          ],
          tags: [],
          requirementId: null,
        }),
      },
    });

    process.stdout.write(JSON.stringify({ id: analysis.id }));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
