/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * #788 — "Generate constitution.md" derives the constitution from the
 * project's own knowledge (README, CONTRIBUTING, go.mod … as retrieved), and
 * says plainly when it can only write the skeleton.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RetrievedChunk } from "@metis/shared";
import type { AIProvider, ChatMessage, ChatResponse } from "../src/lib/ai/types.js";

const artifactRows = new Map<string, any>();
const constitutionRows = new Map<string, any>();
let nextId = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findUnique: vi.fn(async ({ where }: any) =>
        where.id === "p1"
          ? {
              id: "p1",
              name: "Miniflux",
              description: "feed reader",
              safetyMode: "standard",
              aiProviderId: null,
            }
          : null,
      ),
    },
    specKitArtifact: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async ({ where }: any) => {
        for (const r of artifactRows.values()) {
          if (
            r.projectId === where.projectId_name?.projectId &&
            r.name === where.projectId_name?.name
          )
            return r;
        }
        return null;
      }),
      create: vi.fn(async ({ data }: any) => {
        nextId++;
        const row = {
          id: `ska_${nextId}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          projectId: data.projectId,
          name: data.name,
          content: data.content ?? "",
          version: 1,
          updatedById: data.updatedById ?? null,
        };
        artifactRows.set(row.id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const r = artifactRows.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
    },
    specKitConstitution: {
      findUnique: vi.fn(async ({ where }: any) => constitutionRows.get(where.projectId) ?? null),
      upsert: vi.fn(async ({ where, update, create }: any) => {
        const existing = constitutionRows.get(where.projectId);
        if (existing) return Object.assign(existing, update);
        const row = { id: `c_${nextId++}`, ...create };
        constitutionRows.set(where.projectId, row);
        return row;
      }),
    },
  },
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../src/lib/finops/index.js", () => ({
  assertWithinBudget: vi.fn(async () => undefined),
  BudgetExceededError: class extends Error {},
  recordUsage: vi.fn(() => ({ totalTokens: 0, costCents: 0 })),
}));
vi.mock("../src/lib/safety/index.js", () => ({
  applySafety: vi.fn(async (text: string) => ({ text, redacted: false })),
  SafetyDeniedError: class extends Error {},
}));

import { draftConstitution } from "../src/lib/spec-kit/commands/constitution-draft.js";
import { validateConstitution } from "../src/lib/spec-kit/constitution-meta.js";
import { AIProviderError } from "../src/lib/ai/errors.js";

const README: RetrievedChunk = {
  chunkId: "c1",
  documentId: "d-readme",
  filename: "README.md",
  position: 0,
  text: "Miniflux is minimalist: Go standard library first, PostgreSQL only, no JavaScript frameworks.",
  score: 0.9,
  source: "upload",
} as unknown as RetrievedChunk;

function knowledge(hits: RetrievedChunk[]) {
  return { search: vi.fn(async () => ({ hits })) };
}
const noCode = {
  searcher: { search: vi.fn(async () => []) },
  lineLookup: { resolve: vi.fn(async () => new Map()) },
} as any;

class Provider {
  readonly key = "anthropic";
  readonly model = "m";
  offline = false;
  systems: string[] = [];
  constructor(private readonly reply: string) {}
  async chat(_m: ChatMessage[], o: any): Promise<ChatResponse> {
    this.systems.push(String(o?.systemMessage ?? ""));
    return {
      content: this.reply,
      provider: this.key,
      model: this.model,
      usage: { promptTokens: 3, completionTokens: 4, totalTokens: 7 },
      finishReason: "stop",
    } as unknown as ChatResponse;
  }
}

const DRAFT = [
  "# Project Constitution",
  "",
  "Version: 1.0.0",
  "Ratified: 2026-10-08",
  "Last Amended: 2026-10-08",
  "",
  "# Core Principles",
  "",
  "## Go standard library first",
  "Prefer the standard library over third-party packages (README).",
  "",
  "## PostgreSQL only",
  "No other database is supported (README).",
  "",
  "# Governance",
  "",
  "Amend through /speckit.constitution.",
  "",
  "# History",
  "",
  "- 2026-10-08: Derived from the README.",
].join("\n");

const TODAY = new Date("2026-10-08T12:00:00Z");
const stored = (): string =>
  [...artifactRows.values()].find((r) => r.name === "constitution.md")!.content;

beforeEach(() => {
  artifactRows.clear();
  constitutionRows.clear();
  nextId = 0;
});
afterEach(() => vi.clearAllMocks());

describe("#788 draftConstitution", () => {
  it("derives the principles from retrieved project knowledge and versions the result", async () => {
    const provider = new Provider(DRAFT);
    const resolveProvider = vi.fn(async () => provider as unknown as AIProvider);
    const r = await draftConstitution({
      projectId: "p1",
      resolveProvider,
      knowledgeService: knowledge([README]),
      fusedCode: noCode,
      today: TODAY,
    });
    expect(r.grounded).toBe(true);
    // The retrieved README reached the model.
    expect(provider.systems[0]).toContain("Go standard library first, PostgreSQL only");
    expect(stored()).toContain("## Go standard library first");
    expect(stored()).not.toContain("BEGIN auto-managed");
    // Tracked by the semver metadata, like /speckit.constitution.
    expect(r.meta?.version).toBe("1.0.0");
    expect(constitutionRows.get("p1").version).toBe("1.0.0");
    expect(r.message).toMatch(/from project knowledge/);
    expect(r.message).toMatch(/grounded on 1 retrieved chunk/);
  });

  it("completes a draft missing metadata and sections so it validates", async () => {
    const bare = [
      "```markdown",
      "# Core Principles",
      "",
      "## Minimalism",
      "Do less (README).",
      "```",
    ].join("\n");
    const r = await draftConstitution({
      projectId: "p1",
      resolveProvider: async () => new Provider(bare) as unknown as AIProvider,
      knowledgeService: knowledge([README]),
      fusedCode: noCode,
      today: TODAY,
    });
    expect(r.grounded).toBe(true);
    expect(validateConstitution(stored()).ok).toBe(true);
    expect(stored()).toMatch(/^Ratified: 2026-10-08$/m);
    expect(stored()).toMatch(/^Last Amended: 2026-10-08$/m);
    expect(stored()).not.toContain("```");
    expect(stored()).toContain("## Minimalism");
  });

  it("appends the caller's project overrides to a derived constitution", async () => {
    await draftConstitution({
      projectId: "p1",
      projectOverrides: "Every migration needs a rollback.",
      resolveProvider: async () => new Provider(DRAFT) as unknown as AIProvider,
      knowledgeService: knowledge([README]),
      fusedCode: noCode,
      today: TODAY,
    });
    expect(stored()).toContain("Every migration needs a rollback.");
  });

  it("writes the labelled skeleton, without resolving a provider, when nothing is retrieved", async () => {
    const resolveProvider = vi.fn();
    const r = await draftConstitution({
      projectId: "p1",
      resolveProvider,
      knowledgeService: knowledge([]),
      fusedCode: noCode,
      today: TODAY,
    });
    expect(resolveProvider).not.toHaveBeenCalled();
    expect(r.grounded).toBe(false);
    expect(r.meta).toBeNull();
    expect(r.message).toMatch(/skeleton/i);
    expect(r.message).toMatch(/no project knowledge/);
    expect(stored()).toContain("BEGIN auto-managed");
  });

  it("writes the skeleton when the project's provider is not configured", async () => {
    const r = await draftConstitution({
      projectId: "p1",
      resolveProvider: async () => {
        throw new AIProviderError("not configured");
      },
      knowledgeService: knowledge([README]),
      fusedCode: noCode,
      today: TODAY,
    });
    expect(r.grounded).toBe(false);
    expect(r.message).toMatch(/no AI provider/);
  });

  it("does not swallow an unexpected provider error", async () => {
    await expect(
      draftConstitution({
        projectId: "p1",
        resolveProvider: async () => {
          throw new Error("boom");
        },
        knowledgeService: knowledge([README]),
        fusedCode: noCode,
        today: TODAY,
      }),
    ).rejects.toThrow("boom");
  });

  it("writes the skeleton for an offline provider, with no model call", async () => {
    const provider = new Provider(DRAFT);
    provider.offline = true;
    const r = await draftConstitution({
      projectId: "p1",
      resolveProvider: async () => provider as unknown as AIProvider,
      knowledgeService: knowledge([README]),
      fusedCode: noCode,
      today: TODAY,
    });
    expect(provider.systems).toHaveLength(0);
    expect(r.grounded).toBe(false);
  });

  it("writes the skeleton when the model returns no principles", async () => {
    const r = await draftConstitution({
      projectId: "p1",
      resolveProvider: async () =>
        new Provider("I cannot help with that.") as unknown as AIProvider,
      knowledgeService: knowledge([README]),
      fusedCode: noCode,
      today: TODAY,
    });
    expect(r.grounded).toBe(false);
    expect(r.message).toMatch(/no principles/);
    expect(stored()).toContain("BEGIN auto-managed");
  });
});
