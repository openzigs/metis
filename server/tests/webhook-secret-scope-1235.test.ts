/**
 * #1235 — `resolveWebhookSecret`'s failure paths, each of which must fail closed
 * with the one fixed message: the races between the check and the read (a
 * secret deleted, or rotated by an admin, in between), a decryption that
 * throws the vault's real "not found" error, an unreadable audit trail, and
 * binders that cannot be judged. Prisma, roles and the vault are in-memory
 * doubles so each interleaving is deterministic; the real-database path is
 * `webhook-secret-scope-1235.sqlite.test.ts`. No secret here is real.
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

const task = { id: "task-1", scheduledJobId: "job-1" } as TaskRecord;

function reasons(): string[] {
  return auditSpy.mock.calls
    .map(([e]) => e as { action: string; metadata: { reason: string } })
    .filter((e) => e.action === "scheduler.webhook.secret_refused")
    .map((e) => e.metadata.reason);
}

async function refusal(ref = SECRET_ID): Promise<Error> {
  const err = await resolveWebhookSecret(ref, task).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WebhookSecretRefusedError);
  expect((err as Error).message).toBe(WEBHOOK_SECRET_REFUSED_MESSAGE);
  expect((err as Error).message).not.toContain(SECRET_ID);
  return err as Error;
}

const legacy = (actorId: string | null, changes: string[], ts = new Date(1_000)) => ({
  actorId,
  ts,
  metadata: JSON.stringify({ changes }),
});
const marked = (actorId: string | null, webhookBinding: boolean, ts: Date) => ({
  actorId,
  ts,
  metadata: JSON.stringify({ changes: ["payload"], webhookBinding }),
});

beforeEach(() => {
  vi.clearAllMocks();
  roles.clear();
  roles.set("cora", "coordinator");
  roles.set("ada", "admin");
  db.scheduledJob.findUnique.mockResolvedValue({
    id: "job-1",
    projectId: "p-1",
    createdById: "cora",
    deletedAt: null,
  });
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
    db.auditLog.findMany.mockResolvedValueOnce([
      { actorId: "cora", ts: new Date(), metadata: "{" },
    ]);
    await refusal();
    expect(reasons()).toEqual(["audit_unreadable"]);
  });

  it("a pre-fix binding edit whose actor is unknown cannot be judged, so it is refused", async () => {
    db.auditLog.findMany.mockResolvedValueOnce([legacy(null, ["payload"])]);
    await refusal();
    expect(reasons()).toEqual(["no_owner"]);
  });

  it("a pre-fix edit with no `changes` list is treated as a binding edit", async () => {
    roles.set("cora", "admin");
    db.auditLog.findMany.mockResolvedValueOnce([
      { actorId: "mallory", ts: new Date(), metadata: JSON.stringify({}) },
    ]);
    db.user.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
      where.id === "mallory" ? null : { status: "active", deletedAt: null },
    );
    await refusal();
    expect(reasons()).toEqual(["principal_inactive"]);
  });

  it("two binding writes in the same millisecond: both binders are judged", async () => {
    db.scheduledJob.findUnique.mockResolvedValueOnce({
      id: "job-1",
      projectId: "p-1",
      createdById: "ada",
      deletedAt: null,
    });
    const at = new Date(5_000);
    db.auditLog.findMany.mockResolvedValueOnce([marked("ada", true, at), marked("bob", true, at)]);
    roles.set("bob", "coordinator");
    await refusal();
    expect(reasons()).toEqual(["secret_not_owned"]);
  });

  it("a later binding write replaces the binders; a non-binding write leaves them", async () => {
    // Cora's own secret, but Ada bound it last: Ada is judged, Cora is not.
    db.auditLog.findMany.mockResolvedValueOnce([
      legacy("mallory", ["payload"]),
      marked("ada", true, new Date(2_000)),
      marked("mallory", false, new Date(3_000)),
    ]);
    await expect(resolveWebhookSecret(SECRET_ID, task)).resolves.toBe("fake-plaintext");
    expect(db.user.findUnique).toHaveBeenCalledTimes(1);
    expect(db.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ada" } }),
    );
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
