/**
 * #1504 — a GitHub trigger's `event` is the bare GitHub event name.
 *
 * The receiver compares a trigger's `config.event` with the bare event the
 * delivery is (`issues`), never `event.action`, so a trigger saved as
 * `issues.opened` (the settings page's old placeholder) never fired and nothing
 * said why. The CRUD routes now refuse a dotted `event` on a GitHub trigger,
 * naming the bare event — but never rewrite a trigger already stored that way,
 * and still let it be renamed, disabled or re-enabled.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

interface TestUser {
  userId: string;
  role: string;
  workspaces: string[];
}
const ADMIN: TestUser = { userId: "admin-1", role: "admin", workspaces: [] };
let currentUser: TestUser = ADMIN;
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: TestUser }).user = currentUser;
    next();
  },
}));

const projectFindUnique = vi.fn();
const triggerFindFirst = vi.fn();
const triggerCreate = vi.fn();
const triggerUpdate = vi.fn();
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: projectFindUnique },
    trigger: {
      findMany: vi.fn(),
      findFirst: triggerFindFirst,
      create: triggerCreate,
      update: triggerUpdate,
      delete: vi.fn(),
    },
  },
}));

vi.mock("../src/lib/async/runner.js", () => ({
  getAsyncRunner: () => ({ submit: vi.fn(async () => ({ id: "bg_1" })) }),
}));

const { projectTriggersRouter } = await import("../src/routes/triggers.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");

function row(source: string, config: Record<string, unknown>) {
  return {
    id: "trg_1",
    projectId: "proj-1",
    name: "GH",
    source,
    config: JSON.stringify(config),
    enabled: true,
    lastFiredAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/projects/:projectId/triggers", projectTriggersRouter());
  a.use(errorHandler);
  return a;
}

const post = (body: Record<string, unknown>) =>
  request(app()).post("/api/projects/proj-1/triggers").send(body);
const patch = (body: Record<string, unknown>) =>
  request(app()).patch("/api/projects/proj-1/triggers/trg_1").send(body);

/** The stored row the PATCH acts on. */
function stored(source: string, config: Record<string, unknown>) {
  triggerFindFirst.mockImplementation(async () => row(source, config));
  triggerUpdate.mockImplementation(async () => row(source, config));
}

beforeEach(() => {
  vi.clearAllMocks();
  currentUser = ADMIN;
  projectFindUnique.mockResolvedValue({
    workspaceId: "ws-1",
    workspace: { deletedAt: null, members: [{ id: "m" }] },
  });
  triggerCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    row(String(data.source), JSON.parse(String(data.config)) as Record<string, unknown>),
  );
});

describe("#1504 — creating a trigger", () => {
  it("refuses a GitHub trigger whose event is `issues.opened`, naming `issues`", async () => {
    const res = await post({
      name: "GH",
      source: "github",
      config: { repo: "acme/app", event: "issues.opened", secret: "s1" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_TRIGGER_EVENT");
    expect(res.body.error.message).toContain('use "issues"');
    expect(res.body.error.message).toContain("action filtering isn't supported");
    expect(triggerCreate).not.toHaveBeenCalled();
  });

  it("names the bare event for any dotted value (`pull_request.closed`)", async () => {
    const res = await post({
      name: "GH",
      source: "github",
      config: { event: "pull_request.closed" },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('use "pull_request"');
  });

  it("refuses a value with nothing before the dot, with a generic hint", async () => {
    const res = await post({ name: "GH", source: "github", config: { event: ".opened" } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('such as "issues"');
    expect(triggerCreate).not.toHaveBeenCalled();
  });

  it("accepts the bare event name", async () => {
    const res = await post({
      name: "GH",
      source: "github",
      config: { repo: "acme/app", event: "issues", secret: "s1" },
    });
    expect(res.status).toBe(201);
    expect(triggerCreate).toHaveBeenCalledTimes(1);
  });

  it("accepts a GitHub trigger with no event filter", async () => {
    const res = await post({ name: "GH", source: "github", config: { repo: "acme/app" } });
    expect(res.status).toBe(201);
  });

  it("leaves non-GitHub sources alone (a dotted `event` there is not a GitHub event)", async () => {
    const res = await post({ name: "Hook", source: "webhook", config: { event: "a.b" } });
    expect(res.status).toBe(201);
  });
});

describe("#1504 — authorization still runs before the event check", () => {
  const dotted = { name: "GH", source: "github", config: { event: "issues.opened" } };

  it("404s a non-admin of another workspace without revealing the event refusal", async () => {
    currentUser = { userId: "u-other", role: "coordinator", workspaces: ["ws-other"] };
    projectFindUnique.mockResolvedValue({
      workspaceId: "ws-1",
      workspace: { deletedAt: null, members: [] },
    });
    const created = await post(dotted);
    expect(created.status).toBe(404);
    expect(JSON.stringify(created.body)).not.toContain("issues.opened");
    stored("github", { event: "issues" });
    const patched = await patch({ config: { event: "issues.opened" } });
    expect(patched.status).toBe(404);
    expect(triggerCreate).not.toHaveBeenCalled();
    expect(triggerUpdate).not.toHaveBeenCalled();
  });

  it("403s a member of the project's workspace who lacks admin.write", async () => {
    currentUser = { userId: "u-reader", role: "reader", workspaces: ["ws-1"] };
    const created = await post(dotted);
    expect(created.status).toBe(403);
    expect(JSON.stringify(created.body)).not.toContain("issues.opened");
    stored("github", { event: "issues" });
    const patched = await patch({ config: { event: "issues.opened" } });
    expect(patched.status).toBe(403);
    expect(triggerCreate).not.toHaveBeenCalled();
    expect(triggerUpdate).not.toHaveBeenCalled();
  });
});

describe("#1504 — updating a trigger", () => {
  it("refuses a config change that sets a dotted event on a stored GitHub trigger", async () => {
    stored("github", { repo: "acme/app", event: "issues" });
    const res = await patch({ config: { repo: "acme/app", event: "issues.opened" } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('use "issues"');
    expect(triggerUpdate).not.toHaveBeenCalled();
  });

  it("refuses switching a stored trigger with a dotted event to the GitHub source", async () => {
    stored("webhook", { event: "issues.opened" });
    const res = await patch({ source: "github" });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('use "issues"');
    expect(triggerUpdate).not.toHaveBeenCalled();
  });

  it("refuses source and config changed together into a dotted GitHub event", async () => {
    stored("webhook", {});
    const res = await patch({ source: "github", config: { event: "push.created" } });
    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('use "push"');
  });

  it("accepts a config change that fixes a stored dotted event", async () => {
    stored("github", { event: "issues.opened" });
    const res = await patch({ config: { event: "issues" } });
    expect(res.status).toBe(200);
    expect(triggerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { config: JSON.stringify({ event: "issues" }) } }),
    );
  });

  it("accepts moving a stored dotted GitHub trigger to another source", async () => {
    stored("github", { event: "issues.opened" });
    const res = await patch({ source: "webhook" });
    expect(res.status).toBe(200);
  });

  it("still lets a stored dotted GitHub trigger be disabled, without rewriting its config", async () => {
    stored("github", { repo: "acme/app", event: "issues.opened" });
    const res = await patch({ enabled: false });
    expect(res.status).toBe(200);
    expect(triggerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { enabled: false } }),
    );
  });

  it("still lets a stored dotted GitHub trigger be renamed", async () => {
    stored("github", { event: "issues.opened" });
    const res = await patch({ name: "Renamed" });
    expect(res.status).toBe(200);
    expect(triggerUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: { name: "Renamed" } }),
    );
  });
});
