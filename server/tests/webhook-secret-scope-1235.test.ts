/**
 * #1235 — `resolveWebhookSecret`'s failure paths, each of which must fail closed
 * with the one fixed message: a task whose binding is not the job's, the races
 * between the check and the read (a secret deleted, or rotated by an admin, in
 * between), a decryption that throws the vault's real "not found" error, an
 * unreadable audit trail, and binders that cannot be judged. Prisma, roles and
 * the vault are in-memory doubles so each interleaving is deterministic; the
 * real-database path is `webhook-secret-scope-1235.sqlite.test.ts`. No secret
 * here is real.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  scheduledJob: { findUnique: vi.fn() },
  auditLog: { findMany: vi.fn() },
  secret: { findMany: vi.fn(), findFirst: vi.fn() },
  user: { findUnique: vi.fn() },
}));
const auditSpy = vi.hoisted(() => vi.fn());
const decrypt = vi.hoisted(() => vi.fn());
const roles = vi.hoisted(() => new Map<string, string>());

vi.mock("../src/lib/prisma.js", () => ({ prisma: db }));
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: auditSpy }));
vi.mock("../src/lib/auth/durable-roles.js", () => ({
  resolveDurableRole: vi.fn(async (id: string) => roles.get(id) ?? "reader"),
}));
vi.mock("../src/lib/scheduler/project-access.js", () => ({
  actorHasProjectAccess: vi.fn(async () => true),
}));
vi.mock("../src/lib/vault/vault-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/vault/vault-service.js")>()),
  getVaultService: () => ({ decrypt }),
}));

const { resolveWebhookSecret, WebhookSecretRefusedError, WEBHOOK_SECRET_REFUSED_MESSAGE } =
  await import("../src/lib/scheduler/webhook-secret-scope.js");
const { SecretNotFoundError } = await import("../src/lib/vault/vault-service.js");
type TaskRecord = import("../src/lib/scheduler/types.js").TaskRecord;

const SECRET_ID = "sec-1235-owned";
const ROW = {
  id: SECRET_ID,
  name: "global:hook-token",
  createdById: "cora",
  bindingWriteUntil: null,
};
const LIVE = { createdById: "cora", ciphertext: "ct", algorithm: "aes-256-gcm", keyVersion: 1 };

const PAYLOAD = { url: "https://hooks.example.test/in", authHeader: `\${vault:${SECRET_ID}}` };
const task = {
  id: "task-1",
  scheduledJobId: "job-1",
  type: "http-webhook",
  projectId: "p-1",
  payload: PAYLOAD,
} as unknown as TaskRecord;

/** The job row as the fire-time check selects it; never bound since #1235 by default. */
const jobRow = (over: Record<string, unknown> = {}) => ({
  id: "job-1",
  projectId: "p-1",
  taskType: "http-webhook",
  payload: JSON.stringify(PAYLOAD),
  createdById: "cora",
  webhookBinderId: null,
  webhookBoundAt: null,
  deletedAt: null,
  ...over,
});

function reasons(): string[] {
  return auditSpy.mock.calls
    .map(([e]) => e as { action: string; metadata: { reason: string } })
    .filter((e) => e.action === "scheduler.webhook.secret_refused")
    .map((e) => e.metadata.reason);
}

async function refusal(ref = SECRET_ID, t: TaskRecord = task): Promise<Error> {
  const err = await resolveWebhookSecret(ref, t).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WebhookSecretRefusedError);
  expect((err as Error).message).toBe(WEBHOOK_SECRET_REFUSED_MESSAGE);
  expect((err as Error).message).not.toContain(SECRET_ID);
  return err as Error;
}

const legacy = (actorId: string | null, changes: string[]) => ({
  actorId,
  metadata: JSON.stringify({ changes }),
});
const marked = (actorId: string | null, webhookBinding: boolean) => ({
  actorId,
  metadata: JSON.stringify({ changes: ["payload"], webhookBinding }),
});

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks leaves mockResolvedValueOnce queues in place, so an unconsumed
  // once-value leaks into the next test; reset the per-test doubles (not the
  // vi.mock factory implementations) to drain them.
  for (const fn of [
    db.scheduledJob.findUnique,
    db.auditLog.findMany,
    db.secret.findMany,
    db.secret.findFirst,
    db.user.findUnique,
    auditSpy,
    decrypt,
  ]) {
    fn.mockReset();
  }
  roles.clear();
  roles.set("cora", "coordinator");
  roles.set("bob", "coordinator");
  roles.set("ada", "admin");
  db.scheduledJob.findUnique.mockResolvedValue(jobRow());
  db.auditLog.findMany.mockResolvedValue([]);
  db.secret.findMany.mockResolvedValue([ROW]);
  db.secret.findFirst.mockResolvedValue(LIVE);
  db.user.findUnique.mockResolvedValue({ status: "active", deletedAt: null });
  decrypt.mockResolvedValue("fake-plaintext");
});

describe("#1235 resolveWebhookSecret — fails closed on every path", () => {
  it("sends the plaintext decrypted from the row whose owner was judged", async () => {
    await expect(resolveWebhookSecret(SECRET_ID, task)).resolves.toBe("fake-plaintext");
    expect(db.secret.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: SECRET_ID, deletedAt: null } }),
    );
    expect(decrypt).toHaveBeenCalledWith({
      ciphertext: "ct",
      algorithm: "aes-256-gcm",
      keyVersion: 1,
    });
  });

  it("a secret deleted between the check and the read: refused, nothing named, nothing decrypted", async () => {
    db.secret.findFirst.mockResolvedValueOnce(null);
    await refusal();
    expect(decrypt).not.toHaveBeenCalled();
    expect(reasons()).toEqual(["secret_changed"]);
  });

  it('an admin\'s "Rotate anyway" between the check and the read (owner moved): refused, the new value never decrypted', async () => {
    db.secret.findFirst.mockResolvedValueOnce({
      ...LIVE,
      createdById: "ada",
      ciphertext: "ct-new",
    });
    await refusal();
    expect(decrypt).not.toHaveBeenCalled();
    expect(reasons()).toEqual(["secret_changed"]);
  });

  it("the vault throwing its real not-found error maps to the fixed message, never 'Secret <id> not found'", async () => {
    decrypt.mockRejectedValueOnce(new SecretNotFoundError(SECRET_ID));
    await refusal();
    expect(reasons()).toEqual(["check_failed"]);
  });

  it("an audit trail that cannot be read refuses before any secret is read", async () => {
    db.auditLog.findMany.mockRejectedValueOnce(new Error("database is locked"));
    await refusal();
    expect(db.secret.findFirst).not.toHaveBeenCalled();
    expect(reasons()).toEqual(["audit_unreadable"]);
  });

  it("an audit row whose metadata is not JSON counts as unreadable", async () => {
    db.auditLog.findMany.mockResolvedValueOnce([{ actorId: "cora", metadata: "{" }]);
    await refusal();
    expect(reasons()).toEqual(["audit_unreadable"]);
  });

  it("a task with no job is refused before any query", async () => {
    const err = await resolveWebhookSecret(SECRET_ID, { ...task, scheduledJobId: null }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(WebhookSecretRefusedError);
    expect(db.scheduledJob.findUnique).not.toHaveBeenCalled();
    expect(reasons()).toEqual(["no_job"]);
  });

  it("a database error anywhere else in the check maps to the fixed message", async () => {
    db.secret.findMany.mockRejectedValueOnce(new Error(`row ${SECRET_ID} is corrupt`));
    await refusal();
    expect(reasons()).toEqual(["check_failed"]);
  });
});

describe("#1235 resolveWebhookSecret — the task must carry the job's current binding", () => {
  it.each([
    ["URL", { payload: { ...PAYLOAD, url: "https://hooks.example.test/elsewhere" } }],
    ["project", { projectId: "p-2" }],
    ["reference", { payload: { ...PAYLOAD, authHeader: `\${vault:other-secret}` } }],
    ["task type", { type: "rerun-analysis" }],
  ])(
    "a task whose %s is not the job's is refused as stale, before any principal or secret is read",
    async (_what, over) => {
      // The job is bound by an admin since #1235, so only staleness can refuse it.
      db.scheduledJob.findUnique.mockResolvedValueOnce(
        jobRow({ webhookBinderId: "ada", webhookBoundAt: new Date(1_000) }),
      );
      await refusal(SECRET_ID, { ...task, ...over } as TaskRecord);
      expect(reasons()).toEqual(["binding_stale"]);
      expect(db.auditLog.findMany).not.toHaveBeenCalled();
      expect(db.user.findUnique).not.toHaveBeenCalled();
      expect(db.secret.findFirst).not.toHaveBeenCalled();
      expect(decrypt).not.toHaveBeenCalled();
    },
  );

  it("a task differing from the job only in its body is the same binding, and sends", async () => {
    const withBody = { ...task, payload: { ...PAYLOAD, body: { edited: true } } } as TaskRecord;
    await expect(resolveWebhookSecret(SECRET_ID, withBody)).resolves.toBe("fake-plaintext");
  });
});

describe("#1235 resolveWebhookSecret — whose standing the binding rests on", () => {
  it("a job bound since the fix judges its stored binder, and reads no audit trail", async () => {
    db.scheduledJob.findUnique.mockResolvedValueOnce(
      jobRow({ webhookBinderId: "ada", webhookBoundAt: new Date(1_000) }),
    );
    // A pre-fix tamper by an unknown actor: irrelevant once the job was re-bound.
    db.auditLog.findMany.mockResolvedValue([legacy("mallory", ["payload"])]);
    await expect(resolveWebhookSecret(SECRET_ID, task)).resolves.toBe("fake-plaintext");
    expect(db.auditLog.findMany).not.toHaveBeenCalled();
    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ada" } }),
    );
  });

  it("the stored binder is judged even when the audit trail names someone else (a lost row)", async () => {
    // Cora bound her own secret; an admin's "Rotate anyway" has since moved it
    // to Ada. Cora's audit row is lost: the trail shows only an earlier binding
    // by Ada, who holds `vault.reveal` and would pass.
    db.scheduledJob.findUnique.mockResolvedValueOnce(
      jobRow({ createdById: "ada", webhookBinderId: "cora", webhookBoundAt: new Date(2_000) }),
    );
    db.auditLog.findMany.mockResolvedValue([marked("ada", true)]);
    db.secret.findMany.mockResolvedValueOnce([{ ...ROW, createdById: "ada" }]);
    db.secret.findFirst.mockResolvedValueOnce({ ...LIVE, createdById: "ada" });
    await refusal();
    expect(reasons()).toEqual(["secret_not_owned"]);
    expect(decrypt).not.toHaveBeenCalled();
  });

  it("a binding nobody was judged for (a system write since the fix) is refused", async () => {
    db.scheduledJob.findUnique.mockResolvedValueOnce(
      jobRow({ createdById: "ada", webhookBinderId: null, webhookBoundAt: new Date(1_000) }),
    );
    await refusal();
    expect(reasons()).toEqual(["no_owner"]);
  });

  it("a pre-fix binding edit whose actor is unknown cannot be judged, so it is refused", async () => {
    db.auditLog.findMany.mockResolvedValueOnce([legacy(null, ["payload"])]);
    await refusal();
    expect(reasons()).toEqual(["no_owner"]);
  });

  it("a pre-fix edit with no `changes` list is treated as a binding edit", async () => {
    roles.set("cora", "admin");
    db.auditLog.findMany.mockResolvedValueOnce([
      { actorId: "mallory", metadata: JSON.stringify({}) },
    ]);
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "mallory" ? null : { status: "active", deletedAt: null },
    );
    await refusal();
    expect(reasons()).toEqual(["principal_inactive"]);
  });

  it.each([["payload"], ["projectId"], ["taskType"]])(
    "a pre-fix edit of `%s` by a coordinator counts against an admin-authored job",
    async (field) => {
      db.scheduledJob.findUnique.mockResolvedValueOnce(jobRow({ createdById: "ada" }));
      db.secret.findMany.mockResolvedValueOnce([{ ...ROW, createdById: "ada" }]);
      db.auditLog.findMany.mockResolvedValueOnce([legacy("bob", [field])]);
      await refusal();
      expect(reasons()).toEqual(["secret_not_owned"]);
    },
  );

  it("pre-fix edits of other fields do not count", async () => {
    db.scheduledJob.findUnique.mockResolvedValueOnce(jobRow({ createdById: "ada" }));
    db.secret.findMany.mockResolvedValueOnce([{ ...ROW, createdById: "ada" }]);
    db.secret.findFirst.mockResolvedValueOnce({ ...LIVE, createdById: "ada" });
    db.auditLog.findMany.mockResolvedValueOnce([legacy("bob", ["name", "enabled", "cron"])]);
    await expect(resolveWebhookSecret(SECRET_ID, task)).resolves.toBe("fake-plaintext");
  });

  it("on a job never bound since the fix, a marked binding row adds its binder; it never replaces one", async () => {
    // The refused binder comes FIRST, so a row that replaced the set would
    // leave only Ada (admin), who passes.
    db.scheduledJob.findUnique.mockResolvedValueOnce(jobRow({ createdById: "ada" }));
    db.secret.findMany.mockResolvedValueOnce([{ ...ROW, createdById: "ada" }]);
    db.secret.findFirst.mockResolvedValueOnce({ ...LIVE, createdById: "ada" });
    db.auditLog.findMany.mockResolvedValueOnce([marked("bob", true), marked("ada", true)]);
    await refusal();
    expect(reasons()).toEqual(["secret_not_owned"]);
  });

  it("on a job never bound since the fix, a marked non-binding row adds nobody", async () => {
    db.auditLog.findMany.mockResolvedValueOnce([marked("mallory", false)]);
    await expect(resolveWebhookSecret(SECRET_ID, task)).resolves.toBe("fake-plaintext");
    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
  });
});
