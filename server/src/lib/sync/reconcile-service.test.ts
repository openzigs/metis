/**
 * Epic #739 — Tests for the reconciliation service.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  reconcileIssueChange,
  resolveDriftEvent,
  getDriftEventProjectId,
  listDriftEvents,
  getDriftCount,
} from "./reconcile-service.js";
import type { IssueChangeEvent } from "@metis/shared";
import { prisma } from "../prisma.js";
import { registerSocketServer } from "../socket/registry.js";
import {
  buildMarkerComment,
  buildSourceMarkerComment,
  injectMarker,
  parseMarker,
} from "../publishing/dedup.js";
import { bodyWithCodeAsText } from "../publishing/draft-code-links.js";

// Mock prisma
vi.mock("../prisma.js", () => ({
  prisma: {
    publishedIssue: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    driftEvent: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    issueDraft: {
      update: vi.fn(),
    },
  },
}));

vi.mock("../audit/audit-service.js", () => ({
  audit: vi.fn(),
}));

vi.mock("../logger.js", () => ({
  createChildLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

function makeEvent(overrides: Partial<IssueChangeEvent> = {}): IssueChangeEvent {
  return {
    deliveryId: "delivery-123",
    source: "github",
    externalId: "node-id-abc",
    externalRef: "42",
    action: "edited",
    changes: { title: "New Title" },
    current: {
      title: "New Title",
      body: "Updated body",
      state: "open",
      labels: ["bug"],
      assignees: ["user1"],
    },
    timestamp: "2026-01-01T00:00:00Z",
    actor: "octocat",
    ...overrides,
  };
}

describe("reconcileIssueChange", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns not handled when no published issue found", async () => {
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue(null);

    const result = await reconcileIssueChange(makeEvent());

    expect(result.handled).toBe(false);
    expect(result.reason).toBe("NO_PUBLISHED_ISSUE");
  });

  it("creates drift event when changes are detected", async () => {
    const mockPublished = {
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      issueId: "node-id-abc",
      htmlUrl: "https://github.com/org/repo/issues/42",
      status: "created",
      destination: "github",
      parentIssueNumber: null,
      dedupHash: null,
      bodyHash: null,
      errorMessage: null,
      publishedAt: new Date(),
      batch: {
        id: "batch-1",
        projectId: "proj-1",
        project: { id: "proj-1", name: "Test" },
      },
      draft: {
        id: "draft-1",
        title: "Old Title",
        body: "Old body",
        labels: "[]",
        requirementId: "req-1",
      },
    };
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue(mockPublished as never);

    const mockDriftEvent = {
      id: "drift-1",
      publishedIssueId: "pub-1",
      projectId: "proj-1",
      requirementId: "req-1",
      source: "github",
      deliveryId: "delivery-123",
      action: "edited",
      fieldDiffs: JSON.stringify([
        { field: "title", local: "Old Title", external: "New Title" },
        { field: "body", local: "Old body", external: "Updated body" },
      ]),
      externalSnapshot: JSON.stringify({
        title: "New Title",
        body: "Updated body",
        state: "open",
        labels: ["bug"],
        assignees: ["user1"],
      }),
      localSnapshot: JSON.stringify({
        title: "Old Title",
        body: "Old body",
        state: "open",
        labels: [],
        assignees: [],
      }),
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(prisma.driftEvent.create).mockResolvedValue(mockDriftEvent as never);

    const emitDrift = vi.fn();
    const result = await reconcileIssueChange(makeEvent(), { emitDrift });

    expect(result.handled).toBe(true);
    expect(result.driftEventId).toBe("drift-1");
    expect(emitDrift).toHaveBeenCalledWith("proj-1", expect.objectContaining({ id: "drift-1" }));
  });

  /**
   * Issue #78 — the injected `emitDrift` above was the ONLY thing that ever
   * called it: every real caller (both webhook receivers and the Jira poll
   * worker) passed no deps, so the broadcast never happened in production while
   * this suite stayed green. Assert the default path, with no deps at all.
   */
  it("broadcasts drift:detected with no injected emitter (#78)", async () => {
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue({
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      batch: { id: "batch-1", projectId: "proj-1", project: { id: "proj-1", name: "Test" } },
      draft: {
        id: "draft-1",
        title: "Old Title",
        body: "Old body",
        labels: "[]",
        requirementId: "req-1",
      },
    } as never);
    vi.mocked(prisma.driftEvent.create).mockResolvedValue({
      id: "drift-2",
      publishedIssueId: "pub-1",
      projectId: "proj-1",
      requirementId: "req-1",
      source: "github",
      deliveryId: "delivery-2",
      action: "edited",
      fieldDiffs: JSON.stringify([]),
      externalSnapshot: JSON.stringify({}),
      localSnapshot: JSON.stringify({}),
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const emit = vi.fn();
    registerSocketServer({ to: vi.fn(() => ({ emit })) } as never);
    try {
      const result = await reconcileIssueChange(makeEvent());
      expect(result.handled).toBe(true);
      expect(emit).toHaveBeenCalledWith(
        "drift:detected",
        expect.objectContaining({ projectId: "proj-1", driftEventId: "drift-2" }),
      );
    } finally {
      registerSocketServer(null as never);
    }
  });

  it("returns not handled on duplicate deliveryId", async () => {
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue({
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      issueId: "node-id-abc",
      htmlUrl: "",
      status: "created",
      destination: "github",
      parentIssueNumber: null,
      dedupHash: null,
      bodyHash: null,
      errorMessage: null,
      publishedAt: new Date(),
      batch: { id: "batch-1", projectId: "proj-1", project: { id: "proj-1" } },
      draft: { id: "draft-1", title: "Different", body: "Diff", labels: "[]", requirementId: null },
    } as never);

    const prismaError = new Error("Unique constraint") as Error & { code: string };
    prismaError.code = "P2002";
    vi.mocked(prisma.driftEvent.create).mockRejectedValue(prismaError);

    const result = await reconcileIssueChange(makeEvent());
    expect(result.handled).toBe(false);
    expect(result.reason).toBe("DUPLICATE");
  });

  it("returns no_diff when fields match", async () => {
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue({
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      issueId: "node-id-abc",
      htmlUrl: "",
      status: "created",
      destination: "github",
      parentIssueNumber: null,
      dedupHash: null,
      bodyHash: null,
      errorMessage: null,
      publishedAt: new Date(),
      batch: { id: "batch-1", projectId: "proj-1", project: { id: "proj-1" } },
      draft: {
        id: "draft-1",
        title: "New Title",
        body: "Updated body",
        labels: JSON.stringify(["bug"]),
        requirementId: null,
      },
    } as never);

    // Event with same fields as local
    const event = makeEvent({
      current: {
        title: "New Title",
        body: "Updated body",
        state: "open",
        labels: ["bug"],
        assignees: [],
      },
    });
    const result = await reconcileIssueChange(event);
    expect(result.handled).toBe(false);
    expect(result.reason).toBe("NO_DIFF");
  });

  describe("METIS's own marker block is not drift (#1064)", () => {
    const BLOCK =
      "\n\n<!-- metis-source: project=proj-1 analysis=an-1 requirement=req-1 -->\n" +
      "<!-- metis-publish: batch=batch-1 draft=draft-1 hash=abc -->\n";
    const published = (draftBody: string) =>
      ({
        id: "pub-1",
        batchId: "batch-1",
        draftId: "draft-1",
        issueNumber: 42,
        issueId: "node-id-abc",
        status: "created",
        batch: { id: "batch-1", projectId: "proj-1", project: { id: "proj-1" } },
        draft: {
          id: "draft-1",
          title: "New Title",
          body: draftBody,
          labels: JSON.stringify(["bug"]),
          requirementId: null,
        },
      }) as never;
    const remote = (body: string) =>
      makeEvent({
        current: { title: "New Title", body, state: "open", labels: ["bug"], assignees: [] },
      });

    it("an issue that differs from its draft only by the marker block has not drifted", async () => {
      vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue(published("Draft body"));
      const result = await reconcileIssueChange(remote(`Draft body${BLOCK}`));
      expect(result).toEqual({ handled: false, reason: "NO_DIFF" });
      expect(prisma.driftEvent.create).not.toHaveBeenCalled();
    });

    it("a real edit is reported without the marker block in the diff or the snapshot", async () => {
      vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue(published("Draft body"));
      vi.mocked(prisma.driftEvent.create).mockResolvedValue({
        id: "drift-1",
        publishedIssueId: "pub-1",
        projectId: "proj-1",
        requirementId: null,
        source: "github",
        deliveryId: "delivery-123",
        action: "edited",
        createdAt: new Date(),
      } as never);
      const emitDrift = vi.fn();
      await reconcileIssueChange(remote(`Edited on GitHub${BLOCK}`), { emitDrift });

      const data = vi.mocked(prisma.driftEvent.create).mock.calls[0]![0].data;
      expect(JSON.parse(data.fieldDiffs as string)).toEqual([
        { field: "body", local: "Draft body", external: "Edited on GitHub" },
      ]);
      expect(JSON.parse(data.externalSnapshot as string).body).toBe("Edited on GitHub");
      expect(data.fieldDiffs).not.toContain("metis-");
      expect(data.externalSnapshot).not.toContain("metis-");
      // The row broadcast to the UI carries the same stripped snapshot.
      expect(emitDrift.mock.calls[0]![1].externalSnapshot.body).toBe("Edited on GitHub");
    });

    it("marker-shaped text in the middle of the remote body is kept: only the block is cut", async () => {
      vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue(published("Draft body"));
      vi.mocked(prisma.driftEvent.create).mockResolvedValue({
        id: "drift-1",
        createdAt: new Date(),
      } as never);
      const edited = "a `<!-- metis-source: x -->` b";
      await reconcileIssueChange(remote(`${edited}${BLOCK}`), { emitDrift: vi.fn() });
      const data = vi.mocked(prisma.driftEvent.create).mock.calls[0]![0].data;
      expect(JSON.parse(data.externalSnapshot as string).body).toBe(edited);
    });
  });

  it("#744 — a pre-#744 draft's hidden finding label (never published) is not drift", async () => {
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue({
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      issueId: "node-id-abc",
      htmlUrl: "",
      status: "created",
      destination: "github",
      parentIssueNumber: null,
      dedupHash: null,
      bodyHash: null,
      errorMessage: null,
      publishedAt: new Date(),
      batch: { id: "batch-1", projectId: "proj-1", project: { id: "proj-1" } },
      draft: {
        id: "draft-1",
        title: "New Title",
        body: "Updated body",
        labels: JSON.stringify(["bug", "finding:cmv1tix0d0vyu7d9kr8tbqrgq"]),
        requirementId: null,
      },
    } as never);
    const event = makeEvent({
      current: {
        title: "New Title",
        body: "Updated body",
        state: "open",
        labels: ["bug"],
        assignees: [],
      },
    });
    const result = await reconcileIssueChange(event);
    expect(result.reason).toBe("NO_DIFF");
  });

  it("#744 — an issue published before #744 still carries finding:<id> on GitHub; that is not drift", async () => {
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue({
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      issueId: "node-id-abc",
      htmlUrl: "",
      status: "created",
      destination: "github",
      parentIssueNumber: null,
      dedupHash: null,
      bodyHash: null,
      errorMessage: null,
      publishedAt: new Date(),
      batch: { id: "batch-1", projectId: "proj-1", project: { id: "proj-1" } },
      draft: {
        id: "draft-1",
        title: "New Title",
        body: "Updated body",
        labels: JSON.stringify(["bug", "finding:cmv1tix0d0vyu7d9kr8tbqrgq"]),
        requirementId: null,
      },
    } as never);
    const event = makeEvent({
      current: {
        title: "New Title",
        body: "Updated body",
        state: "open",
        labels: ["bug", "finding:cmv1tix0d0vyu7d9kr8tbqrgq"],
        assignees: [],
      },
    });
    const result = await reconcileIssueChange(event);
    expect(result.reason).toBe("NO_DIFF");
  });

  describe("#1276 — what the publisher adds or drops is not drift", () => {
    const DRAFT_BODY =
      "> Parent epic: **[Epic] Apollo — 2 requirements**\n\n## Description\n\nLogin.\n\n## Acceptance criteria\n\n- [ ] ok";
    const PUBLISHED_BODY =
      "> Parent epic: **[Epic] Apollo — 2 requirements** ([#7](https://github.com/acme/metis/issues/7))\n\n" +
      "## Description\n\nLogin.\n\n" +
      "METIS could not confirm the code references behind this item; check them before relying on them.\n\n" +
      "## Acceptance criteria\n\n- [ ] ok";

    function seedPublished(labels: string[]) {
      vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue({
        id: "pub-1",
        batchId: "batch-1",
        draftId: "draft-1",
        issueNumber: 42,
        issueId: "node-id-abc",
        htmlUrl: "",
        status: "created",
        destination: "github",
        parentIssueNumber: null,
        dedupHash: null,
        bodyHash: null,
        errorMessage: null,
        publishedAt: new Date(),
        batch: { id: "batch-1", projectId: "proj-1", project: { id: "proj-1" } },
        draft: {
          id: "draft-1",
          title: "[Feature] Login",
          body: DRAFT_BODY,
          labels: JSON.stringify(labels),
          requirementId: null,
        },
      } as never);
    }

    it("an issue published from an `unverified` draft, with its epic's number, has not drifted", async () => {
      seedPublished(["feature", "unverified"]);
      const event = makeEvent({
        current: {
          title: "[Feature] Login",
          body: PUBLISHED_BODY,
          state: "open",
          labels: ["feature"],
          assignees: [],
        },
      });
      expect((await reconcileIssueChange(event)).reason).toBe("NO_DIFF");
    });

    it("an issue published before #1276 still carries `unverified` on GitHub; that is not drift", async () => {
      seedPublished(["feature", "unverified"]);
      const event = makeEvent({
        current: {
          title: "[Feature] Login",
          body: DRAFT_BODY,
          state: "open",
          labels: ["feature", "unverified"],
          assignees: [],
        },
      });
      expect((await reconcileIssueChange(event)).reason).toBe("NO_DIFF");
    });

    it("a real edit is still reported, without the publisher's additions in the snapshot", async () => {
      seedPublished(["feature", "unverified"]);
      vi.mocked(prisma.driftEvent.create).mockImplementation((async ({
        data,
      }: {
        data: Record<string, unknown>;
      }) => ({ id: "drift-x", createdAt: new Date(), ...data })) as never);
      const event = makeEvent({
        current: {
          title: "[Feature] Login",
          body: PUBLISHED_BODY.replace("Login.", "Login, now with SSO."),
          state: "open",
          labels: ["feature"],
          assignees: [],
        },
      });
      const result = await reconcileIssueChange(event);
      expect(result.handled).toBe(true);
      const data = vi.mocked(prisma.driftEvent.create).mock.calls.at(-1)![0].data as {
        externalSnapshot: string;
      };
      const external = JSON.parse(data.externalSnapshot) as { body: string };
      expect(external.body).toBe(DRAFT_BODY.replace("Login.", "Login, now with SSO."));
    });
  });
});

describe("#1049 — the batch's Additional labels are what was published, not drift", () => {
  beforeEach(() => vi.clearAllMocks());

  function seedPublished(additionalLabels: unknown) {
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue({
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      issueId: "node-id-abc",
      htmlUrl: "",
      status: "created",
      destination: "github",
      parentIssueNumber: null,
      dedupHash: null,
      bodyHash: null,
      errorMessage: null,
      publishedAt: new Date(),
      batch: {
        id: "batch-1",
        projectId: "proj-1",
        metadata: JSON.stringify({ draftIds: ["draft-1"], additionalLabels }),
        project: { id: "proj-1" },
      },
      draft: {
        id: "draft-1",
        title: "T",
        body: "Body",
        labels: JSON.stringify(["feature", "unverified"]),
        requirementId: null,
      },
    } as never);
  }

  const eventWithLabels = (labels: string[]) =>
    makeEvent({ current: { title: "T", body: "Body", state: "open", labels, assignees: [] } });

  it("an issue carrying the batch's labels as published has not drifted", async () => {
    seedPublished(["sprint-42", "unverified"]);
    const result = await reconcileIssueChange(eventWithLabels(["feature", "sprint-42"]));
    expect(result.reason).toBe("NO_DIFF");
  });

  it("a Jira issue is compared with the labels in the form Jira was sent", async () => {
    seedPublished(["good first issue"]);
    const published = (await prisma.publishedIssue.findFirst({} as never)) as unknown as Record<
      string,
      unknown
    >;
    vi.mocked(prisma.publishedIssue.findFirst).mockResolvedValue({
      ...published,
      destination: "jira",
    } as never);
    const result = await reconcileIssueChange(
      makeEvent({
        source: "jira",
        current: {
          title: "T",
          body: "Body",
          state: "open",
          labels: ["feature", "good-first-issue"],
          assignees: [],
        },
      }),
    );
    expect(result.reason).toBe("NO_DIFF");
  });

  it("removing a batch label on the tracker is still drift", async () => {
    seedPublished(["sprint-42"]);
    vi.mocked(prisma.driftEvent.create).mockImplementation((async ({
      data,
    }: {
      data: Record<string, unknown>;
    }) => ({ id: "drift-x", createdAt: new Date(), ...data })) as never);
    const result = await reconcileIssueChange(eventWithLabels(["feature"]));
    expect(result.handled).toBe(true);
    const data = vi.mocked(prisma.driftEvent.create).mock.calls.at(-1)![0].data as {
      fieldDiffs: string;
    };
    expect(JSON.parse(data.fieldDiffs)).toEqual([
      { field: "labels", local: ["feature", "sprint-42"], external: ["feature"] },
    ]);
  });

  it("adopting the tracker's labels does not copy the batch's labels into the draft", async () => {
    const existing = {
      id: "drift-1",
      publishedIssueId: "pub-1",
      projectId: "proj-1",
      requirementId: null,
      source: "github",
      deliveryId: "del-1",
      action: "edited",
      fieldDiffs: JSON.stringify([{ field: "labels", local: [], external: [] }]),
      externalSnapshot: JSON.stringify({
        title: "T",
        body: "Body",
        state: "open",
        labels: ["bug", "Sprint-42", "docs", "good-first-issue"],
        assignees: [],
      }),
      localSnapshot: null,
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.driftEvent.update).mockResolvedValue({
      ...existing,
      status: "resolved",
      resolution: "adopt",
      resolvedById: "user-1",
      resolvedAt: new Date(),
    } as never);
    vi.mocked(prisma.publishedIssue.findUnique).mockResolvedValue({
      id: "pub-1",
      draftId: "draft-1",
      // `good first issue` reached Jira as `good-first-issue`; still the batch's.
      batch: {
        metadata: JSON.stringify({ additionalLabels: ["sprint-42", "docs", "good first issue"] }),
      },
      // The draft already carried `docs` itself, so it keeps it.
      draft: { requirementId: null, labels: JSON.stringify(["feature", "docs"]) },
    } as never);
    vi.mocked(prisma.issueDraft.update).mockResolvedValue({} as never);

    await resolveDriftEvent("drift-1", "adopt", "user-1");
    const data = vi.mocked(prisma.issueDraft.update).mock.calls.at(-1)![0].data as {
      labels: string;
    };
    expect(JSON.parse(data.labels)).toEqual(["bug", "docs"]);
  });
});

describe("#1049 review — one issue, a row per batch: the newest row speaks for it", () => {
  beforeEach(() => vi.clearAllMocks());

  /** Batch A (older, `sprint-41`) then batch B (newer, `sprint-42`) published the issue. */
  const row = (id: string, batchLabels: string[], publishedAt: string) => ({
    id,
    batchId: `batch-${id}`,
    draftId: "draft-1",
    issueNumber: 42,
    issueId: "node-id-abc",
    htmlUrl: "",
    status: "updated",
    destination: "github",
    parentIssueNumber: null,
    dedupHash: null,
    bodyHash: null,
    errorMessage: null,
    publishedAt: new Date(publishedAt),
    batch: {
      id: `batch-${id}`,
      projectId: "proj-1",
      metadata: JSON.stringify({ additionalLabels: batchLabels }),
      project: { id: "proj-1" },
    },
    draft: {
      id: "draft-1",
      title: "T",
      body: "Body",
      labels: JSON.stringify(["feature"]),
      requirementId: null,
    },
  });
  const ROWS = [
    row("A", ["sprint-41"], "2026-10-01T00:00:00Z"),
    row("B", ["sprint-42"], "2026-10-02T00:00:00Z"),
  ];

  beforeEach(() => {
    // Without an ORDER BY a database may return any row; here, the oldest.
    vi.mocked(prisma.publishedIssue.findFirst).mockImplementation((async (args: {
      orderBy?: Array<Record<string, "asc" | "desc">> | Record<string, "asc" | "desc">;
    }) => {
      const order = [args.orderBy ?? []].flat();
      const newestFirst = order[0]?.publishedAt === "desc";
      return newestFirst
        ? [...ROWS].sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())[0]
        : ROWS[0];
    }) as never);
    vi.mocked(prisma.driftEvent.create).mockImplementation((async ({
      data,
    }: {
      data: Record<string, unknown>;
    }) => ({ id: "drift-x", createdAt: new Date(), ...data })) as never);
  });

  const event = (labels: string[], body = "Body") =>
    makeEvent({ current: { title: "T", body, state: "open", labels, assignees: [] } });

  it("an issue carrying the newest batch's labels has not drifted", async () => {
    expect((await reconcileIssueChange(event(["feature", "sprint-42"]))).reason).toBe("NO_DIFF");
  });

  it("a real edit is filed against the newest row, so Adopt reads that batch's labels", async () => {
    const result = await reconcileIssueChange(event(["feature", "sprint-42"], "Body, edited"));
    expect(result.handled).toBe(true);
    const data = vi.mocked(prisma.driftEvent.create).mock.calls.at(-1)![0].data as {
      publishedIssueId: string;
      fieldDiffs: string;
    };
    expect(data.publishedIssueId).toBe("B");
    expect(JSON.parse(data.fieldDiffs).map((d: { field: string }) => d.field)).toEqual(["body"]);

    // Adopt then strips B's own batch label from the draft, not A's.
    const existing = {
      id: "drift-x",
      publishedIssueId: "B",
      projectId: "proj-1",
      requirementId: null,
      source: "github",
      deliveryId: "d",
      action: "edited",
      fieldDiffs: data.fieldDiffs,
      externalSnapshot: JSON.stringify({
        title: "T",
        body: "Body, edited",
        state: "open",
        labels: ["feature", "sprint-42"],
        assignees: [],
      }),
      localSnapshot: null,
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.driftEvent.update).mockResolvedValue({
      ...existing,
      status: "resolved",
      resolution: "adopt",
    } as never);
    vi.mocked(prisma.publishedIssue.findUnique).mockImplementation((async ({
      where,
    }: {
      where: { id: string };
    }) => ROWS.find((r) => r.id === where.id)) as never);
    vi.mocked(prisma.issueDraft.update).mockResolvedValue({} as never);
    await resolveDriftEvent("drift-x", "adopt", "user-1");
    const adopted = vi.mocked(prisma.issueDraft.update).mock.calls.at(-1)![0].data as {
      labels: string;
    };
    expect(JSON.parse(adopted.labels)).toEqual(["feature"]);
  });
});

describe("getDriftEventProjectId (#102)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the owning project of the drift addressed by id", async () => {
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue({ projectId: "proj-7" } as never);
    await expect(getDriftEventProjectId("drift-7")).resolves.toBe("proj-7");
    expect(prisma.driftEvent.findUnique).toHaveBeenCalledWith({
      where: { id: "drift-7" },
      select: { projectId: true },
    });
  });

  it("returns null for an unknown drift", async () => {
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(null);
    await expect(getDriftEventProjectId("nope")).resolves.toBeNull();
  });
});

describe("resolveDriftEvent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws DRIFT_NOT_FOUND for unknown id", async () => {
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(null);
    await expect(resolveDriftEvent("unknown", "adopt", "user-1")).rejects.toThrow(
      "DRIFT_NOT_FOUND",
    );
  });

  it("throws ALREADY_RESOLVED if already resolved", async () => {
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue({
      id: "drift-1",
      status: "resolved",
    } as never);
    await expect(resolveDriftEvent("drift-1", "adopt", "user-1")).rejects.toThrow(
      "ALREADY_RESOLVED",
    );
  });

  it("resolves with adopt action and updates draft", async () => {
    const existing = {
      id: "drift-1",
      publishedIssueId: "pub-1",
      projectId: "proj-1",
      requirementId: "req-1",
      source: "github",
      deliveryId: "del-1",
      action: "edited",
      fieldDiffs: JSON.stringify([{ field: "title", local: "Old", external: "New" }]),
      externalSnapshot: JSON.stringify({
        title: "New",
        body: "Body",
        state: "open",
        labels: [],
        assignees: [],
      }),
      localSnapshot: JSON.stringify({
        title: "Old",
        body: "Body",
        state: "open",
        labels: [],
        assignees: [],
      }),
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.driftEvent.update).mockResolvedValue({
      ...existing,
      status: "resolved",
      resolution: "adopt",
      resolvedById: "user-1",
      resolvedAt: new Date(),
    } as never);
    vi.mocked(prisma.publishedIssue.findUnique).mockResolvedValue({
      id: "pub-1",
      draftId: "draft-1",
    } as never);
    vi.mocked(prisma.issueDraft.update).mockResolvedValue({} as never);

    const result = await resolveDriftEvent("drift-1", "adopt", "user-1");
    expect(result.status).toBe("resolved");
    expect(result.resolution).toBe("adopt");
    expect(prisma.issueDraft.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "draft-1" } }),
    );
  });

  it("#1276 — adopting the tracker's labels keeps the draft's internal labels", async () => {
    const existing = {
      id: "drift-1",
      publishedIssueId: "pub-1",
      projectId: "proj-1",
      requirementId: null,
      source: "github",
      deliveryId: "del-1",
      action: "edited",
      fieldDiffs: JSON.stringify([{ field: "labels", local: ["feature"], external: ["bug"] }]),
      externalSnapshot: JSON.stringify({
        title: "T",
        body: "Body",
        state: "open",
        labels: ["bug", "Unverified"],
        assignees: [],
      }),
      localSnapshot: null,
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.driftEvent.update).mockResolvedValue({
      ...existing,
      status: "resolved",
      resolution: "adopt",
      resolvedById: "user-1",
      resolvedAt: new Date(),
    } as never);
    vi.mocked(prisma.publishedIssue.findUnique).mockResolvedValue({
      id: "pub-1",
      draftId: "draft-1",
      draft: {
        requirementId: null,
        labels: JSON.stringify(["feature", "unverified", "finding:abc"]),
      },
    } as never);
    vi.mocked(prisma.issueDraft.update).mockResolvedValue({} as never);

    await resolveDriftEvent("drift-1", "adopt", "user-1");
    const data = vi.mocked(prisma.issueDraft.update).mock.calls.at(-1)![0].data as {
      labels: string;
    };
    expect(JSON.parse(data.labels)).toEqual(["bug", "unverified", "finding:abc"]);
  });

  it("#1064 — adopting never copies a marker into the draft", async () => {
    // A snapshot stored before the block was stripped at detection still ends
    // with it, and holds marker-shaped text a tracker user typed mid-body.
    const adopted =
      "Edited on GitHub with `<!-- metis-publish: batch=x draft=y hash=z -->` in it\n\n" +
      "<!-- metis-source: project=proj-1 -->\n" +
      "<!-- metis-publish: batch=batch-1 draft=draft-1 hash=abc -->\n";
    const existing = {
      id: "drift-1",
      publishedIssueId: "pub-1",
      projectId: "proj-1",
      requirementId: null,
      source: "github",
      deliveryId: "del-1",
      action: "edited",
      fieldDiffs: "[]",
      externalSnapshot: JSON.stringify({
        title: "T",
        body: adopted,
        state: "open",
        labels: [],
        assignees: [],
      }),
      localSnapshot: "{}",
      status: "pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.driftEvent.update).mockResolvedValue({
      ...existing,
      status: "resolved",
      resolution: "adopt",
    } as never);
    vi.mocked(prisma.publishedIssue.findUnique).mockResolvedValue({
      id: "pub-1",
      draftId: "draft-1",
    } as never);
    vi.mocked(prisma.issueDraft.update).mockResolvedValue({} as never);

    await resolveDriftEvent("drift-1", "adopt", "user-1");

    const body = vi.mocked(prisma.issueDraft.update).mock.calls[0]![0].data.body as string;
    expect(body).toBe(
      "Edited on GitHub with `<!- - metis-publish: batch=x draft=y hash=z -->` in it",
    );
    expect(body).not.toMatch(/<!--\s*metis-/);
  });

  it("resolves with divergent action without updating draft", async () => {
    const existing = {
      id: "drift-2",
      publishedIssueId: "pub-2",
      projectId: "proj-1",
      requirementId: null,
      source: "jira",
      deliveryId: "del-2",
      action: "closed",
      fieldDiffs: JSON.stringify([{ field: "state", local: "open", external: "closed" }]),
      externalSnapshot: JSON.stringify({
        title: "T",
        body: "B",
        state: "closed",
        labels: [],
        assignees: [],
      }),
      localSnapshot: null,
      status: "pending",
      resolution: null,
      resolvedById: null,
      resolvedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(prisma.driftEvent.findUnique).mockResolvedValue(existing as never);
    vi.mocked(prisma.driftEvent.update).mockResolvedValue({
      ...existing,
      status: "resolved",
      resolution: "divergent",
      resolvedById: "user-1",
      resolvedAt: new Date(),
    } as never);

    const result = await resolveDriftEvent("drift-2", "divergent", "user-1");
    expect(result.resolution).toBe("divergent");
    expect(prisma.issueDraft.update).not.toHaveBeenCalled();
  });
});

describe("listDriftEvents", () => {
  it("returns paginated results", async () => {
    const items = [
      {
        id: "d-1",
        publishedIssueId: "pub-1",
        projectId: "proj-1",
        requirementId: null,
        source: "github",
        deliveryId: "del-1",
        action: "edited",
        fieldDiffs: "[]",
        externalSnapshot: "{}",
        localSnapshot: null,
        status: "pending",
        resolution: null,
        resolvedById: null,
        resolvedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    vi.mocked(prisma.driftEvent.findMany).mockResolvedValue(items as never);
    vi.mocked(prisma.driftEvent.count).mockResolvedValue(1);

    const result = await listDriftEvents("proj-1", { page: 1, perPage: 10 });
    expect(result.total).toBe(1);
    expect(result.items).toHaveLength(1);
  });
});

describe("getDriftCount", () => {
  it("returns pending count", async () => {
    vi.mocked(prisma.driftEvent.count).mockResolvedValue(5);
    const count = await getDriftCount("proj-1");
    expect(count).toBe(5);
  });
});

// ---- #1102 review, cycle 2 -------------------------------------------------

describe("drift → Adopt, through both functions, on bodies METIS itself published", () => {
  const HASH = "a".repeat(64);
  const PUBLISH = { batchId: "batch-1", draftId: "draft-1", hash: HASH };
  const SOURCE = { projectId: "proj-1", analysisId: "an-1", requirementId: "req-1" };

  /** The rows the two functions read and write, as one small store. */
  function store(draft: { body: string; metadata?: string | null }, destination = "github") {
    const state = {
      draft: {
        id: "draft-1",
        projectId: "proj-1",
        title: "T",
        body: draft.body,
        labels: "[]",
        requirementId: "req-1",
        metadata: draft.metadata ?? null,
      },
      drifts: new Map<string, Record<string, unknown>>(),
    };
    const published = {
      id: "pub-1",
      batchId: "batch-1",
      draftId: "draft-1",
      issueNumber: 42,
      issueId: "node-id-abc",
      status: "created",
      destination,
      dedupHash: destination === "github" ? HASH : null,
    };
    vi.mocked(prisma.publishedIssue.findFirst).mockImplementation((async () => ({
      ...published,
      batch: { id: "batch-1", projectId: "proj-1", project: { id: "proj-1" } },
      draft: { ...state.draft },
    })) as never);
    vi.mocked(prisma.publishedIssue.findUnique).mockImplementation((async () => ({
      ...published,
      draft: { requirementId: state.draft.requirementId },
    })) as never);
    vi.mocked(prisma.driftEvent.create).mockImplementation((async ({
      data,
    }: {
      data: Record<string, unknown>;
    }) => {
      const row = { id: `drift-${state.drifts.size + 1}`, createdAt: new Date(), ...data };
      state.drifts.set(row.id, row);
      return row;
    }) as never);
    vi.mocked(prisma.driftEvent.findUnique).mockImplementation(
      (async ({ where }: { where: { id: string } }) => state.drifts.get(where.id) ?? null) as never,
    );
    vi.mocked(prisma.driftEvent.update).mockImplementation((async ({
      where,
      data,
    }: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => {
      const next = { ...state.drifts.get(where.id)!, ...data };
      state.drifts.set(where.id, next);
      return next;
    }) as never);
    vi.mocked(prisma.issueDraft.update).mockImplementation((async ({
      data,
    }: {
      data: { title: string; body: string; labels: string };
    }) => {
      Object.assign(state.draft, data);
      return state.draft;
    }) as never);
    return state;
  }

  /** What the tracker holds after METIS publishes the draft as it now stands. */
  const publishedBody = (body: string) => injectMarker(body, PUBLISH, SOURCE);

  let delivery = 0;
  const webhook = (body: string) =>
    reconcileIssueChange(
      makeEvent({
        deliveryId: `delivery-${(delivery += 1)}`,
        current: { title: "T", body, state: "open", labels: [], assignees: [] },
      }),
      { emitDrift: vi.fn() },
    );

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("a note added BELOW the marker block is adopted without the block — round after round", async () => {
    const state = store({ body: "Body text.\n\n---\n> Generated by METIS" });

    // Round 1: the maintainer adds a line at the end of the issue, under the block.
    const first = await webhook(
      `${publishedBody(state.draft.body)}\nA note the maintainer added on GitHub.`,
    );
    expect(first.handled).toBe(true);
    const drift1 = state.drifts.get(first.driftEventId!)!;
    // Neither the diff nor the snapshot shown for review holds a marker line.
    expect(drift1.fieldDiffs).not.toContain("metis-");
    expect(drift1.externalSnapshot).not.toContain("metis-");
    await resolveDriftEvent(first.driftEventId!, "adopt", "user-1");
    expect(state.draft.body).toBe(
      "Body text.\n\n---\n> Generated by METIS\n\nA note the maintainer added on GitHub.",
    );

    // Round 2: METIS publishes the adopted draft; a second note goes under the new block.
    const second = await webhook(`${publishedBody(state.draft.body)}\nAnd a second note.`);
    expect(second.handled).toBe(true);
    await resolveDriftEvent(second.driftEventId!, "adopt", "user-1");
    expect(state.draft.body).toBe(
      "Body text.\n\n---\n> Generated by METIS\n\nA note the maintainer added on GitHub.\n\nAnd a second note.",
    );

    // No marker text in the draft: not live, not neutralised, no internal id.
    for (const text of [
      "metis-source",
      "metis-publish",
      "<!- -",
      "<!--",
      "proj-1",
      "an-1",
      "req-1",
    ]) {
      expect(state.draft.body, text).not.toContain(text);
    }
    // And the next publish is the draft plus exactly one block.
    expect(publishedBody(state.draft.body)).toBe(
      `${state.draft.body}\n\n${buildSourceMarkerComment(SOURCE)}\n${buildMarkerComment(PUBLISH)}\n`,
    );
    // With the tracker back in step, a further webhook is not drift.
    expect(await webhook(publishedBody(state.draft.body))).toEqual({
      handled: false,
      reason: "NO_DIFF",
    });
  });

  it("a snapshot stored with the block mid-body is cleaned at Adopt too", async () => {
    const state = store({ body: "Body text." });
    // A drift row written before detection removed the lines.
    state.drifts.set("drift-old", {
      id: "drift-old",
      publishedIssueId: "pub-1",
      projectId: "proj-1",
      requirementId: "req-1",
      source: "github",
      deliveryId: "old",
      action: "edited",
      fieldDiffs: "[]",
      externalSnapshot: JSON.stringify({
        title: "T",
        body: `${publishedBody("Body text.")}\nA note.`,
        state: "open",
        labels: [],
        assignees: [],
      }),
      localSnapshot: "{}",
      status: "pending",
      createdAt: new Date(),
    });
    await resolveDriftEvent("drift-old", "adopt", "user-1");
    expect(state.draft.body).toBe("Body text.\n\nA note.");
  });

  it("this issue's source line is known by its requirement when it no longer sits on the publish marker", async () => {
    // A line typed between the two marker lines splits the block.
    const split = `Body text.\n\n${buildSourceMarkerComment(SOURCE)}\nA line in between.\n${buildMarkerComment(PUBLISH)}\n`;
    const state = store({ body: "Body text." });
    const result = await webhook(split);
    expect(state.drifts.get(result.driftEventId!)!.externalSnapshot).not.toContain("metis-");
    await resolveDriftEvent(result.driftEventId!, "adopt", "user-1");
    expect(state.draft.body).toBe("Body text.\n\nA line in between.");

    // Adopt reads the requirement from the draft as well: a snapshot stored
    // with the split block is cleaned the same way.
    state.draft.body = "Body text.";
    state.drifts.set("drift-old", {
      id: "drift-old",
      publishedIssueId: "pub-1",
      projectId: "proj-1",
      fieldDiffs: "[]",
      localSnapshot: "{}",
      createdAt: new Date(),
      externalSnapshot: JSON.stringify({
        title: "T",
        body: split,
        state: "open",
        labels: [],
        assignees: [],
      }),
      status: "pending",
    });
    await resolveDriftEvent("drift-old", "adopt", "user-1");
    expect(state.draft.body).toBe("Body text.\n\nA line in between.");
  });

  it("marker-shaped lines that are NOT this issue's recorded marker are kept, and made inert", async () => {
    const state = store({ body: "Body text." });
    const foreign = [
      buildMarkerComment({ ...PUBLISH, draftId: "draft-other" }),
      buildMarkerComment({ ...PUBLISH, hash: "b".repeat(64) }),
      buildSourceMarkerComment({ ...SOURCE, projectId: "proj-other" })!,
      // Another requirement of the same project: another issue's source line.
      buildSourceMarkerComment({ ...SOURCE, requirementId: "req-other" })!,
      `    ${buildMarkerComment(PUBLISH)}`,
      `quoted: ${buildSourceMarkerComment(SOURCE)}`,
    ];
    const result = await webhook(
      `${publishedBody("Body text.")}\nA note.\n\n${foreign.join("\n")}\n\nThe end.`,
    );
    await resolveDriftEvent(result.driftEventId!, "adopt", "user-1");
    expect(state.draft.body).toBe(
      `Body text.\n\nA note.\n\n${foreign.map((l) => l.replace("<!--", "<!- -")).join("\n")}\n\nThe end.`,
    );
    // Inert: the draft holds no marker, so nothing in it can be read back as one.
    expect(state.draft.body).not.toMatch(/<!--\s*metis-/);
    expect(parseMarker(publishedBody(state.draft.body))).toEqual(PUBLISH);
  });

  it("a draft stored before marker text was neutralised is compared as it was published", async () => {
    // The row still holds live marker-shaped text; what was published is the
    // inert form. The local snapshot must be the published form, or every
    // webhook for this issue reports drift that is not there.
    for (const body of [
      "a `<!-- metis-source: x -->` b",
      "Draft body\n",
      "Draft body   \n\n",
      `Old adopted text\n\n${buildMarkerComment({ ...PUBLISH, draftId: "draft-old" })}\n`,
    ]) {
      store({ body });
      expect(await webhook(publishedBody(body)), JSON.stringify(body)).toEqual({
        handled: false,
        reason: "NO_DIFF",
      });
    }
  });

  it("a Jira issue is compared with the plain form it was published in", async () => {
    const base = "https://github.com/acme/app";
    const linked =
      "## Related code\n\n- [`src/a.ts:3`](https://github.com/acme/app/blob/abc1234/src/a.ts#L3) — `f`\n\n## Definition of done";
    const metadata = JSON.stringify({ codeLinkBase: base });
    const asPublishedToJira = bodyWithCodeAsText({ body: linked, metadata });
    expect(asPublishedToJira).not.toContain("github.com");

    store({ body: linked, metadata }, "jira");
    expect(await webhook(asPublishedToJira)).toEqual({ handled: false, reason: "NO_DIFF" });

    // The GitHub issue of the same draft carries the links, and is compared with them.
    store({ body: linked, metadata }, "github");
    expect(await webhook(publishedBody(linked))).toEqual({ handled: false, reason: "NO_DIFF" });
    const drifted = await webhook(asPublishedToJira);
    expect(drifted.handled).toBe(true);
  });
});
