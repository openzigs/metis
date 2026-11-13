/**
 * Epic #157 — ACL primitives unit tests.
 */
import { describe, expect, it, vi } from "vitest";

// The primitives below read nothing; `saveDocumentAcl` (#2356) is covered on
// real SQLite in `document-acl-save-2356.sqlite.test.ts`.
vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));

import {
  filterAccessible,
  isAdminBypass,
  isVisibleTo,
  parseAclSubjects,
  serializeAclSubjects,
  sharedAudienceActor,
} from "../src/lib/rag/acl.js";

describe("parseAclSubjects", () => {
  it("returns [] for null/undefined/empty", () => {
    expect(parseAclSubjects(null)).toEqual([]);
    expect(parseAclSubjects(undefined)).toEqual([]);
    expect(parseAclSubjects("")).toEqual([]);
    expect(parseAclSubjects("   ")).toEqual([]);
  });

  it("parses a JSON-encoded string", () => {
    const raw = JSON.stringify([{ kind: "role", value: "admin" }]);
    expect(parseAclSubjects(raw)).toEqual([{ kind: "role", value: "admin" }]);
  });

  it("accepts an already-parsed array (Postgres JSONB path)", () => {
    expect(parseAclSubjects([{ kind: "user", value: "u1" }])).toEqual([
      { kind: "user", value: "u1" },
    ]);
  });

  it("drops invalid entries silently", () => {
    const raw = JSON.stringify([
      { kind: "user", value: "u1" },
      { kind: "weird", value: "x" },
      { kind: "role" },
    ]);
    expect(parseAclSubjects(raw)).toEqual([{ kind: "user", value: "u1" }]);
  });

  it("returns [] when the JSON cannot be parsed", () => {
    expect(parseAclSubjects("{not json")).toEqual([]);
    expect(parseAclSubjects(JSON.stringify({ kind: "user" }))).toEqual([]);
  });
});

describe("serializeAclSubjects", () => {
  it("round-trips through parseAclSubjects", () => {
    const subjects = [
      { kind: "user" as const, value: "u1" },
      { kind: "group" as const, value: "g42" },
    ];
    const enc = serializeAclSubjects(subjects);
    expect(parseAclSubjects(enc)).toEqual(subjects);
  });

  it("throws on invalid input", () => {
    // @ts-expect-error invalid kind by design
    expect(() => serializeAclSubjects([{ kind: "weird", value: "x" }])).toThrow();
  });
});

describe("isVisibleTo", () => {
  const empty = { subjects: [] };
  const restricted = {
    subjects: [
      { kind: "user" as const, value: "u1" },
      { kind: "role" as const, value: "manager" },
      { kind: "group" as const, value: "alpha" },
    ],
  };

  it("admin bypasses any ACL", () => {
    expect(isVisibleTo(restricted, { userId: "anyone", role: "admin" })).toBe(true);
  });

  it("empty list = visible to everyone", () => {
    expect(isVisibleTo(empty, { userId: "u9", role: "viewer" })).toBe(true);
  });

  it("matches by user", () => {
    expect(isVisibleTo(restricted, { userId: "u1", role: "viewer" })).toBe(true);
  });

  it("matches by role", () => {
    expect(isVisibleTo(restricted, { userId: "u9", role: "manager" })).toBe(true);
  });

  it("matches by group", () => {
    expect(
      isVisibleTo(restricted, { userId: "u9", role: "viewer", groups: ["beta", "alpha"] }),
    ).toBe(true);
  });

  it("denies when nothing matches", () => {
    expect(isVisibleTo(restricted, { userId: "u9", role: "viewer", groups: ["other"] })).toBe(
      false,
    );
  });
  // #2248 — a reply the whole thread reads sees unrestricted chunks only.
  it("a shared audience sees an unrestricted chunk", () => {
    expect(isVisibleTo(empty, sharedAudienceActor("u1"))).toBe(true);
  });

  it("a shared audience matches no subject, even the trigger's own", () => {
    expect(
      isVisibleTo({ subjects: [{ kind: "user", value: "u1" }] }, sharedAudienceActor("u1")),
    ).toBe(false);
    expect(
      isVisibleTo(
        { subjects: [{ kind: "role", value: "shared-audience" }] },
        sharedAudienceActor("u1"),
      ),
    ).toBe(false);
  });

  it("a shared audience has no admin bypass and no groups", () => {
    const actor = { ...sharedAudienceActor("root"), role: "admin", groups: ["alpha"] };
    expect(isVisibleTo(restricted, actor)).toBe(false);
  });
});

describe("isAdminBypass (#2297)", () => {
  const admin = { userId: "root", role: "admin", groups: ["ops"] };
  const acl = (...subjects: Array<{ kind: "user" | "role" | "group"; value: string }>) => ({
    subjects,
  });

  it("is an admin seeing a restricted list that names them nowhere", () => {
    expect(isAdminBypass(acl({ kind: "user", value: "alice" }), admin)).toBe(true);
  });

  it("is not a bypass when a user, role or group subject names the admin", () => {
    expect(isAdminBypass(acl({ kind: "user", value: "root" }), admin)).toBe(false);
    expect(isAdminBypass(acl({ kind: "role", value: "admin" }), admin)).toBe(false);
    expect(isAdminBypass(acl({ kind: "group", value: "ops" }), admin)).toBe(false);
  });

  it("is never one for an unrestricted list, a non-admin or a shared audience", () => {
    expect(isAdminBypass(acl(), admin)).toBe(false);
    expect(
      isAdminBypass(acl({ kind: "user", value: "alice" }), { userId: "bob", role: "member" }),
    ).toBe(false);
    expect(
      isAdminBypass(acl({ kind: "user", value: "alice" }), {
        ...sharedAudienceActor("root"),
        role: "admin",
      }),
    ).toBe(false);
  });
});

describe("filterAccessible", () => {
  const actor = { userId: "u1", role: "viewer" };

  it("partitions chunks into allowed / denied", () => {
    const result = filterAccessible(
      [
        { chunkId: "c1", aclSubjects: [] },
        {
          chunkId: "c2",
          aclSubjects: [{ kind: "user" as const, value: "someone-else" }],
        },
        { chunkId: "c3", aclSubjects: [{ kind: "user" as const, value: "u1" }] },
      ],
      actor,
    );
    expect(result.allowed.map((r) => r.chunkId)).toEqual(["c1", "c3"]);
    expect(result.deniedChunkIds).toEqual(["c2"]);
  });

  it("treats missing aclSubjects as unrestricted", () => {
    const result = filterAccessible([{ chunkId: "c1" }], actor);
    expect(result.allowed).toHaveLength(1);
    expect(result.deniedChunkIds).toEqual([]);
  });
});
