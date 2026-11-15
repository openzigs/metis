/**
 * #2089 — the binding notice's wording when the people or workspace it names
 * cannot be read. The recipients and the audit entry are covered through the
 * route (`routes/integrations/teams-link.test.ts`) and read back through the
 * notification list (`tests/chat-identity-binding-notice-2089.sqlite.test.ts`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  workspaceMember: { findMany: vi.fn() },
  workspace: { findUnique: vi.fn() },
  user: { findMany: vi.fn() },
  notification: { create: vi.fn() },
}));
vi.mock("../prisma.js", () => ({ prisma: db }));
const auditMock = vi.hoisted(() => vi.fn());
vi.mock("../audit/audit-service.js", () => ({ audit: auditMock }));

import { recordChatIdentityBinding } from "./chatops-identity-binding-notice.js";

describe("recordChatIdentityBinding — fallbacks (#2089)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.workspaceMember.findMany.mockResolvedValue([{ userId: "u-owner" }]);
    db.notification.create.mockResolvedValue({ id: "n-1" });
  });

  it("names nobody it cannot read: no actor, no workspace row, no user rows", async () => {
    db.workspace.findUnique.mockResolvedValue(null);
    db.user.findMany.mockResolvedValue([]);
    await recordChatIdentityBinding({
      actorId: null,
      workspaceId: "ws-1",
      provider: "slack",
      boundUserId: "u-bob",
      externalScope: "T1",
      externalId: "U1",
    });
    expect(db.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["u-bob"] } } }),
    );
    const byUser = Object.fromEntries(
      db.notification.create.mock.calls.map(([a]) => [a.data.userId, a.data]),
    );
    expect(Object.keys(byUser).sort()).toEqual(["u-bob", "u-owner"]);
    expect(byUser["u-owner"].title).toBe("A Slack account can now act as A workspace admin");
    expect(byUser["u-bob"].message).toBe(
      'A workspace admin linked Slack account "U1" to you in a workspace. Chat commands from ' +
        "that account now run with your permissions in this workspace.",
    );
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ actor: null }));
  });

  it("falls back to the username when a display name is empty", async () => {
    db.workspace.findUnique.mockResolvedValue({ name: "Acme" });
    db.user.findMany.mockResolvedValue([
      { id: "u-admin", displayName: "", username: "adam" },
      { id: "u-bob", displayName: "Bob", username: "bob" },
    ]);
    await recordChatIdentityBinding({
      actorId: "u-admin",
      workspaceId: "ws-1",
      provider: "teams",
      boundUserId: "u-bob",
      externalScope: "tenant-a",
      externalId: "aad-1",
    });
    const toBob = db.notification.create.mock.calls.find(([a]) => a.data.userId === "u-bob");
    expect(toBob?.[0].data.message).toMatch(/^adam linked Microsoft Teams account "aad-1" to you/);
  });
});

describe("recordChatIdentityBinding — text the actor chose is quoted and bounded (#2107)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.workspaceMember.findMany.mockResolvedValue([{ userId: "u-owner" }]);
    db.notification.create.mockResolvedValue({ id: "n-1" });
    db.user.findMany.mockResolvedValue([{ id: "u-admin", displayName: "Adam", username: "adam" }]);
  });

  const toOwner = () =>
    db.notification.create.mock.calls.find(([a]) => a.data.userId === "u-owner")?.[0].data;

  it("an external id cannot close its quote or add a line, and is cut to a GUID's length", async () => {
    db.workspace.findUnique.mockResolvedValue({ name: "Acme" });
    const id = 'x" (test only, already removed — no action needed)\n' + "y".repeat(60);
    await recordChatIdentityBinding({
      actorId: "u-admin",
      workspaceId: "ws-1",
      provider: "teams",
      boundUserId: "u-admin",
      externalScope: "tenant-a",
      externalId: id,
    });
    const message: string = toOwner()?.message;
    // The value's own quote is escaped, the newline is shown as \n, and the
    // shown id stops at 40 characters with an ellipsis inside the quotes.
    const shown = JSON.stringify(`${[...id].slice(0, 40).join("")}…`);
    expect(message).toContain(`Microsoft Teams account ${shown} to Adam`);
    expect(message).not.toContain("\n");
    expect(message).not.toContain('account x"');
    expect(message).not.toContain("y".repeat(41));
    // The audit entry keeps the full id.
    expect(auditMock.mock.calls[0][0].metadata.externalId).toBe(id);
  });

  it("an id of exactly 40 characters is shown whole, with no ellipsis", async () => {
    db.workspace.findUnique.mockResolvedValue(null);
    const id = "a".repeat(40);
    await recordChatIdentityBinding({
      actorId: "u-admin",
      workspaceId: "ws-1",
      provider: "teams",
      boundUserId: "u-admin",
      externalScope: "tenant-a",
      externalId: id,
    });
    expect(toOwner()?.message).toContain(`account "${id}" to Adam`);
  });

  it("a workspace name cannot close its quote", async () => {
    db.workspace.findUnique.mockResolvedValue({ name: 'Acme" (ignore this)' });
    await recordChatIdentityBinding({
      actorId: "u-admin",
      workspaceId: "ws-1",
      provider: "teams",
      boundUserId: "u-admin",
      externalScope: "tenant-a",
      externalId: "aad-1",
    });
    expect(toOwner()?.message).toContain('in the workspace "Acme\\" (ignore this)".');
  });
});

describe("recordChatIdentityBinding — invisible and reordering characters are shown escaped (#2175)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.workspaceMember.findMany.mockResolvedValue([{ userId: "u-owner" }]);
    db.notification.create.mockResolvedValue({ id: "n-1" });
    db.user.findMany.mockResolvedValue([{ id: "u-admin", displayName: "Adam", username: "adam" }]);
  });

  const toOwner = () =>
    db.notification.create.mock.calls.find(([a]) => a.data.userId === "u-owner")?.[0].data;

  const bind = (externalId: string) =>
    recordChatIdentityBinding({
      actorId: "u-admin",
      workspaceId: "ws-1",
      provider: "teams",
      boundUserId: "u-admin",
      externalScope: "tenant-a",
      externalId,
    });

  // JSON.stringify leaves every one of these raw: it escapes only quotes,
  // backslashes, C0 controls and lone surrogates.
  it.each([
    ["a right-to-left override", "‮", "\\u202E"],
    ["a left-to-right embedding", "‪", "\\u202A"],
    ["a pop directional formatting", "‬", "\\u202C"],
    ["a first-strong isolate", "⁨", "\\u2068"],
    ["a pop directional isolate", "⁩", "\\u2069"],
    ["a right-to-left mark", "‏", "\\u200F"],
    ["an Arabic letter mark", "؜", "\\u061C"],
    ["a line separator", " ", "\\u2028"],
    ["a paragraph separator", " ", "\\u2029"],
    ["a zero-width space", "​", "\\u200B"],
    ["a zero-width joiner", "‍", "\\u200D"],
    ["a word joiner", "⁠", "\\u2060"],
    ["a byte-order mark", "﻿", "\\uFEFF"],
    ["a soft hyphen", "­", "\\u00AD"],
    // Format, but outside the default-ignorable set: only `\p{Cf}` catches it.
    ["an interlinear annotation anchor", "￹", "\\uFFF9"],
    ["a C1 control (next line)", "\u0085", "\\u0085"],
    ["a Hangul filler", "ㅤ", "\\u3164"],
    ["a tag character", "\u{E0041}", "\\uDB40\\uDC41"],
  ])("an external id holding %s shows it as an escape", async (_label, raw, escaped) => {
    db.workspace.findUnique.mockResolvedValue({ name: "Acme" });
    await bind(`aad${raw}1`);
    const message: string = toOwner()?.message;
    expect(message).toContain(`Microsoft Teams account "aad${escaped}1" to Adam`);
    expect(message).not.toContain(raw);
    // The audit entry keeps the id as given.
    expect(auditMock.mock.calls[0][0].metadata.externalId).toBe(`aad${raw}1`);
  });

  it("a workspace name cannot reverse the sentence after it", async () => {
    // U+202E renders the rest of the line right to left, so the text after the
    // name could read as something the notice never said.
    db.workspace.findUnique.mockResolvedValue({ name: "Acme‮⁦ yltnenamrep" });
    await bind("aad-1");
    const message: string = toOwner()?.message;
    expect(message).toContain('in the workspace "Acme\\u202E\\u2066 yltnenamrep".');
    expect(message).not.toMatch(/[‪-‮⁦-⁩]/u);
  });

  it("counts the cut on the characters given, not on their escapes", async () => {
    db.workspace.findUnique.mockResolvedValue(null);
    // 40 characters, every one invisible: shown whole, as 40 escapes.
    await bind("​".repeat(40));
    expect(toOwner()?.message).toContain(`account "${"\\u200B".repeat(40)}" to Adam`);
  });

  it("leaves ordinary text, accents and other scripts as they are", async () => {
    db.workspace.findUnique.mockResolvedValue({ name: "Café Zürich — שלום 東京" });
    await bind("aad-1");
    expect(toOwner()?.message).toContain('in the workspace "Café Zürich — שלום 東京".');
  });
});

describe("recordChatIdentityBinding — a rebind tells the replaced member, member or not (#2175)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.notification.create.mockResolvedValue({ id: "n-1" });
    db.workspace.findUnique.mockResolvedValue({ name: "Acme" });
    db.user.findMany.mockResolvedValue([
      { id: "u-admin", displayName: "Adam", username: "adam" },
      { id: "u-bob", displayName: "Bob", username: "bob" },
      { id: "u-gone", displayName: "Gina", username: "gina" },
    ]);
  });

  it("notifies a replaced member who has left the workspace, without reading membership", async () => {
    // Only the owner row exists: Gina is no longer a member.
    db.workspaceMember.findMany.mockResolvedValue([{ userId: "u-owner" }]);
    await recordChatIdentityBinding({
      actorId: "u-admin",
      workspaceId: "ws-1",
      provider: "teams",
      boundUserId: "u-bob",
      externalScope: "tenant-a",
      externalId: "aad-1",
      replacedUserId: "u-gone",
    });
    // The one membership read is the owner lookup; nothing filters Gina out.
    expect(db.workspaceMember.findMany).toHaveBeenCalledTimes(1);
    expect(db.workspaceMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { workspaceId: "ws-1", role: "owner" } }),
    );
    const toGina = db.notification.create.mock.calls.find(([a]) => a.data.userId === "u-gone");
    expect(toGina?.[0].data.title).toBe("A Microsoft Teams account no longer acts as you");
    expect(toGina?.[0].data.message).toBe(
      'Adam linked Microsoft Teams account "aad-1", which acted as you, to Bob in the ' +
        'workspace "Acme". Chat commands from that account now run with Bob\'s permissions, ' +
        "not yours.",
    );
  });
});
