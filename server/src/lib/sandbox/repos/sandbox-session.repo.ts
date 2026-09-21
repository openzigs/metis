/**
 * `SandboxSession` repository (Epic #395 #410).
 *
 * Wraps Prisma access so adapter code never touches the model directly.
 * Two methods: `start` (called from `provider.create()`) and `finalize`
 * (called from `Sandbox.destroy()` or the watchdog). Failures bubble
 * through to the caller — the session row is the durable record of
 * sandbox usage and a write failure must not be silently swallowed.
 */
import { prisma } from "../../prisma.js";
import type { SandboxOutcome, SandboxProviderKind } from "../types.js";

export interface SandboxSessionStartInput {
  projectId: string;
  userId?: string | null;
  runId?: string | null;
  provider: SandboxProviderKind;
  vendorSandboxId: string;
  templateId?: string | null;
  vCpus: number;
  memMiB: number;
}

export interface SandboxSessionFinalizeInput {
  destroyedAt: Date;
  wallClockMs: number;
  cpuTimeMs?: number | null;
  costMicroUsd?: number | null;
  outcome: SandboxOutcome;
  errorMessage?: string | null;
}

export interface SandboxSessionRow {
  id: string;
  projectId: string;
  userId: string | null;
  runId: string | null;
  provider: string;
  vendorSandboxId: string;
  templateId: string | null;
  vCpus: number;
  memMiB: number;
  createdAt: Date;
  destroyedAt: Date | null;
  wallClockMs: number | null;
  cpuTimeMs: number | null;
  costMicroUsd: number | null;
  outcome: string | null;
  errorMessage: string | null;
}

export class SandboxSessionRepo {
  async start(input: SandboxSessionStartInput): Promise<SandboxSessionRow> {
    const row = await prisma.sandboxSession.create({
      data: {
        projectId: input.projectId,
        userId: input.userId ?? null,
        runId: input.runId ?? null,
        provider: input.provider,
        vendorSandboxId: input.vendorSandboxId,
        templateId: input.templateId ?? null,
        vCpus: input.vCpus,
        memMiB: input.memMiB,
      },
    });
    return row;
  }

  async finalize(
    sessionId: string,
    input: SandboxSessionFinalizeInput,
  ): Promise<SandboxSessionRow> {
    const row = await prisma.sandboxSession.update({
      where: { id: sessionId },
      data: {
        destroyedAt: input.destroyedAt,
        wallClockMs: input.wallClockMs,
        cpuTimeMs: input.cpuTimeMs ?? null,
        costMicroUsd: input.costMicroUsd ?? null,
        outcome: input.outcome,
        errorMessage: input.errorMessage ?? null,
      },
    });
    return row;
  }

  async findById(id: string, projectId?: string): Promise<SandboxSessionRow | null> {
    if (projectId === undefined) {
      return prisma.sandboxSession.findUnique({ where: { id } });
    }
    return prisma.sandboxSession.findFirst({ where: { id, projectId } });
  }

  async listForProject(
    projectId: string,
    opts: { limit?: number } = {},
  ): Promise<SandboxSessionRow[]> {
    return prisma.sandboxSession.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: opts.limit ?? 50,
    });
  }

  /** Sessions for a single agent run, oldest-first. Capped at 50. */
  async listForRun(runId: string, opts: { limit?: number } = {}): Promise<SandboxSessionRow[]> {
    return prisma.sandboxSession.findMany({
      where: { runId },
      orderBy: { createdAt: "asc" },
      take: opts.limit ?? 50,
    });
  }
}

let singleton: SandboxSessionRepo | null = null;
export function getSandboxSessionRepo(): SandboxSessionRepo {
  if (!singleton) singleton = new SandboxSessionRepo();
  return singleton;
}

/** Test helper. */
export function __resetSandboxSessionRepoSingleton(): void {
  singleton = null;
}
