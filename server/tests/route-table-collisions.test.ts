/**
 * Issue #96 — no path+method may be registered by two routers.
 *
 * `POST /api/webhooks/github/issues` was registered twice: once by the spec-kit
 * task sync (`githubPrWebhookRouter`) and once by the drift reconciler
 * (`syncWebhookRouter`), both mounted at `/webhooks`. Express serves the first
 * match and that handler always answers, so the reconciler was unreachable —
 * GitHub issue edits never produced a `DriftEvent`, and every delivery still
 * read `200 {"ok":true}`.
 *
 * Each router's own tests mount it in isolation, so both passed. The collision
 * exists only in the COMPOSED table, which is what this file reads: the mount
 * paths from `routes/index.ts` source (Express 5 keeps no record of them), the
 * route paths and methods from the assembled runtime stack.
 */
import crypto from "node:crypto";
import express from "express";
import request from "supertest";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readMountTable } from "./helpers/mount-table.js";

const { reconcileCalls, syncIssueEventMock } = vi.hoisted(() => ({
  reconcileCalls: [] as Array<{ source: string; externalId: string; action: string }>,
  syncIssueEventMock: {
    fn: null as null | ((input: unknown) => Promise<unknown>),
  },
}));

// The behavioural half below drives a signed delivery through the REAL composed
// router. Only the two pipeline endpoints and the dedup table are stubbed, so
// "which handler served the request" is the thing under test.
vi.mock("../src/lib/sync/reconcile-service.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    reconcileIssueChange: vi.fn(
      async (event: { source: string; externalId: string; action: string }) => {
        reconcileCalls.push({
          source: event.source,
          externalId: event.externalId,
          action: event.action,
        });
        return { handled: true, driftEventId: "drift-composed-1" };
      },
    ),
  };
});

vi.mock("../src/lib/spec-kit/issue-sync.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    syncIssueEvent: vi.fn(async (input: unknown) =>
      syncIssueEventMock.fn
        ? syncIssueEventMock.fn(input)
        : { handled: false, reason: "NO_TASK_EXPORT" },
    ),
  };
});

vi.mock("../src/lib/agents/pr-reviewer/webhook-dedup.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    recordDelivery: vi.fn(async ({ deliveryId }: { deliveryId: string }) => ({
      duplicate: false,
      deliveryId,
    })),
  };
});

const INDEX_PATH = fileURLToPath(new URL("../src/routes/index.ts", import.meta.url));

/** Minimal structural view of an Express 5 layer. */
interface Layer {
  handle: unknown;
  route?: { path: string | string[]; methods: Record<string, boolean> };
}
type RouterLike = ((...args: unknown[]) => unknown) & { stack: Layer[] };

function asRouter(handle: unknown): RouterLike | null {
  return typeof handle === "function" && Array.isArray((handle as RouterLike).stack)
    ? (handle as RouterLike)
    : null;
}

/** `/projects/:projectId/x/` → `/projects/:param/x` — param NAMES never disambiguate. */
function normalise(path: string): string {
  const joined = path.replace(/\/{2,}/g, "/").replace(/:[A-Za-z0-9_]+/g, ":param");
  return joined.length > 1 ? joined.replace(/\/$/, "") : joined;
}

interface Registration {
  key: string;
  owner: string;
  /** Position in the composed table: Express tries registrations in this order. */
  order: number;
}

/**
 * Every `METHOD path` a mounted router registers directly, attributed to the
 * mount-table entry that owns it. Kept separate from the real table so the detector
 * below can be exercised on a synthetic table as well as the real one.
 */
function collectRegistrations(
  table: Array<{ path: string | null; expression: string; line: number }>,
  stack: Layer[],
): Registration[] {
  const out: Registration[] = [];
  let order = 0;
  table.forEach((entry, i) => {
    if (entry.path === null) return;
    const router = asRouter(stack[i]?.handle);
    if (!router) return;
    for (const layer of router.stack) {
      if (!layer.route) continue;
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const method of Object.keys(layer.route.methods)) {
        for (const p of paths) {
          out.push({
            key: `${method.toUpperCase()} ${normalise(`${entry.path}/${p}`)}`,
            owner: `${entry.expression} (index.ts:${entry.line})`,
            order: order++,
          });
        }
      }
    }
  });
  return out;
}

/**
 * Keys registered more than once — by two mounts (#96) or twice inside ONE
 * router (#113). Either way only the first registration is ever served.
 */
function findCollisions(regs: Registration[]): Array<{ key: string; owners: string[] }> {
  const byKey = new Map<string, string[]>();
  for (const r of regs) byKey.set(r.key, [...(byKey.get(r.key) ?? []), r.owner]);
  return [...byKey.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([key, owners]) => ({ key, owners }));
}

/**
 * #113 — a `:param` route registered BEFORE a literal route of the same method
 * and shape answers the literal's requests: `GET /x/:param` swallows a later
 * `GET /x/export`. Only plain paths are compared (no wildcard/optional syntax).
 */
function findParamShadowing(
  regs: Registration[],
): Array<{ literal: string; shadowedBy: string; owners: string[] }> {
  const parse = (key: string) => {
    const [method, path] = key.split(" ");
    return { method, segments: path.split("/") };
  };
  const plain = regs.filter((r) => !/[*{}()?]/.test(r.key));
  const out: Array<{ literal: string; shadowedBy: string; owners: string[] }> = [];
  for (const later of plain) {
    const b = parse(later.key);
    for (const earlier of plain) {
      if (earlier.order >= later.order || earlier.key === later.key) continue;
      const a = parse(earlier.key);
      if (a.method !== b.method || a.segments.length !== b.segments.length) continue;
      const covers = a.segments.every(
        (seg, i) => seg === b.segments[i] || (seg === ":param" && b.segments[i] !== ":param"),
      );
      if (covers) {
        out.push({
          literal: later.key,
          shadowedBy: earlier.key,
          owners: [earlier.owner, later.owner],
        });
        break;
      }
    }
  }
  return out;
}

const table = readMountTable(INDEX_PATH);
const { apiRouter } = await import("../src/routes/index.js");
const runtimeStack = (apiRouter() as unknown as RouterLike).stack;

describe("composed route table (#96)", () => {
  it("reads the whole mount table, zipped 1:1 with the runtime stack", () => {
    // If this drifts every conclusion below is drawn against the wrong router.
    expect(table.length).toBe(runtimeStack.length);
  });

  it("collects a realistic number of registrations, including the webhook receivers", () => {
    const regs = collectRegistrations(table, runtimeStack);
    // A detector that enumerates nothing can never find a collision.
    expect(regs.length).toBeGreaterThan(200);
    const keys = new Set(regs.map((r) => r.key));
    expect(keys).toContain("POST /webhooks/github/issues");
    expect(keys).toContain("POST /webhooks/jira/issues");
  });

  it("registers no path+method in two different routers", () => {
    const collisions = findCollisions(collectRegistrations(table, runtimeStack));
    expect(
      collisions,
      "A path+method registered by two routers is served only by the first; the second " +
        "handler is dead code that every isolated router test still passes (#96).",
    ).toEqual([]);
  });

  it("registers no literal path after a :param route that already answers it (#113)", () => {
    const shadowed = findParamShadowing(collectRegistrations(table, runtimeStack));
    expect(
      shadowed,
      "A literal route registered after a same-method :param route of the same shape is " +
        "never reached — Express hands its requests to the :param handler (#113).",
    ).toEqual([]);
  });

  it("the detector flags a synthetic duplicate and ignores param-name-only differences", () => {
    const mk = (routes: Array<[string, string]>): Layer => ({
      handle: Object.assign(() => {}, {
        stack: routes.map(([m, p]) => ({
          handle: () => {},
          route: { path: p, methods: { [m]: true } },
        })),
      }),
    });
    const synthetic = [
      { path: "/hooks", expression: "aRouter()", line: 1 },
      { path: "/hooks", expression: "bRouter()", line: 2 },
      { path: "/p/:projectId", expression: "cRouter()", line: 3 },
      { path: "/p/:id", expression: "dRouter()", line: 4 },
    ];
    const stack = [
      mk([["post", "/x"]]),
      mk([
        ["post", "/x"],
        ["get", "/x"],
      ]),
      mk([["get", "/y"]]),
      mk([["get", "/y"]]),
    ];
    const collisions = findCollisions(collectRegistrations(synthetic, stack));
    expect(collisions.map((c) => c.key).sort()).toEqual(["GET /p/:param/y", "POST /hooks/x"]);
  });

  const mkRouter = (routes: Array<[string, string]>): Layer => ({
    handle: Object.assign(() => {}, {
      stack: routes.map(([m, p]) => ({
        handle: () => {},
        route: { path: p, methods: { [m]: true } },
      })),
    }),
  });

  it("the detector flags a duplicate inside ONE router (#113)", () => {
    const synthetic = [{ path: "/hooks", expression: "aRouter()", line: 1 }];
    const stack = [
      mkRouter([
        ["post", "/x"],
        ["get", "/x"],
        ["post", "/x/"],
      ]),
    ];
    const collisions = findCollisions(collectRegistrations(synthetic, stack));
    expect(collisions).toEqual([
      { key: "POST /hooks/x", owners: ["aRouter() (index.ts:1)", "aRouter() (index.ts:1)"] },
    ]);
  });

  it("the shadowing detector flags :param-before-literal, across and within routers (#113)", () => {
    const synthetic = [
      { path: "/projects", expression: "aRouter()", line: 1 },
      { path: "/projects", expression: "bRouter()", line: 2 },
    ];
    const stack = [
      mkRouter([
        ["get", "/:id"],
        ["get", "/:id/docs"],
        ["get", "/:id/stats"], // differs at a literal segment: not a shadow
      ]),
      mkRouter([
        ["get", "/export"], // shadowed by aRouter's GET /:id
        ["post", "/export"], // different method: not shadowed
        ["get", "/:id/docs/all"], // different length: not shadowed
        ["get", "/42/docs"], // shadowed by GET /:id/docs
      ]),
    ];
    const shadowed = findParamShadowing(collectRegistrations(synthetic, stack));
    expect(shadowed.map((s) => [s.literal, s.shadowedBy])).toEqual([
      ["GET /projects/export", "GET /projects/:param"],
      ["GET /projects/42/docs", "GET /projects/:param/docs"],
    ]);
  });

  it("a literal registered BEFORE the :param route is not shadowed (#113)", () => {
    const synthetic = [{ path: "/projects", expression: "aRouter()", line: 1 }];
    const stack = [
      mkRouter([
        ["get", "/export"],
        ["get", "/:id"],
      ]),
    ];
    expect(findParamShadowing(collectRegistrations(synthetic, stack))).toEqual([]);
  });
});

describe("a signed GitHub issues delivery through the composed router (#96)", () => {
  const SECRET = "composed-route-secret";
  // #113 — a value set before this suite must survive it.
  const PRIOR = "prior-webhook-secret";
  const original = process.env.GITHUB_WEBHOOK_SECRET;
  beforeAll(() => {
    process.env.GITHUB_WEBHOOK_SECRET = PRIOR;
  });
  afterAll(() => {
    if (original === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
    else process.env.GITHUB_WEBHOOK_SECRET = original;
  });

  function app() {
    const a = express();
    a.use(
      express.json({
        verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
          req.rawBody = buf.toString("utf8");
        },
      }),
    );
    a.use("/api", apiRouter());
    return a;
  }

  it("reaches the drift reconciler AND the spec-kit task sync", async () => {
    // #113 — restore whatever was there, rather than deleting a value this
    // test did not create.
    const priorSecret = process.env.GITHUB_WEBHOOK_SECRET;
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    reconcileCalls.length = 0;
    const specKitCalls: unknown[] = [];
    syncIssueEventMock.fn = async (input) => {
      specKitCalls.push(input);
      return { handled: false, reason: "NO_TASK_EXPORT" };
    };
    try {
      const body = JSON.stringify({
        action: "edited",
        issue: {
          node_id: "I_kwComposed",
          number: 7,
          title: "Edited on GitHub",
          body: "b",
          state: "open",
          labels: [],
          assignees: [],
        },
        changes: { title: { from: "Original" } },
        repository: { full_name: "acme/proj" },
        sender: { login: "octocat" },
      });
      const sig = "sha256=" + crypto.createHmac("sha256", SECRET).update(body).digest("hex");
      const res = await request(app())
        .post("/api/webhooks/github/issues")
        .set("Content-Type", "application/json")
        .set("X-GitHub-Event", "issues")
        .set("X-GitHub-Delivery", crypto.randomUUID())
        .set("X-Hub-Signature-256", sig)
        .send(body);

      expect(res.status).toBe(200);
      expect(reconcileCalls).toEqual([
        { source: "github", externalId: "I_kwComposed", action: "edited" },
      ]);
      expect(res.body.drift).toEqual({ handled: true, driftEventId: "drift-composed-1" });
      expect(specKitCalls).toHaveLength(1);
      expect(res.body.reason).toBe("NO_TASK_EXPORT");
    } finally {
      if (priorSecret === undefined) delete process.env.GITHUB_WEBHOOK_SECRET;
      else process.env.GITHUB_WEBHOOK_SECRET = priorSecret;
      syncIssueEventMock.fn = null;
    }
  });

  it("leaves the GITHUB_WEBHOOK_SECRET it found in place (#113)", () => {
    expect(process.env.GITHUB_WEBHOOK_SECRET).toBe(PRIOR);
  });
});
