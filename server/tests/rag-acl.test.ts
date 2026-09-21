/**
 * Epic #157 — ACL primitives unit tests.
 */
import { describe, expect, it, vi } from "vitest";

const { documentUpdate, knowledgeChunkUpdateMany } = vi.hoisted(() => ({
  documentUpdate: vi.fn(async () => ({})),
  knowledgeChunkUpdateMany: vi.fn(async () => ({ count: 7 })),
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    document: { update: documentUpdate },
    knowledgeChunk: { updateMany: knowledgeChunkUpdateMany },
  },
}));

import {
  filterAccessible,
  isVisibleTo,
  parseAclSubjects,
  propagateAcl,
  serializeAclSubjects,
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

describe("propagateAcl", () => {
  it("updates the document + bulk-updates chunk ACLs", async () => {
    const subjects = [
      { kind: "user" as const, value: "u1" },
      { kind: "group" as const, value: "alpha" },
    ];
    const count = await propagateAcl("doc1", subjects);
    expect(count).toBe(7);
    expect(documentUpdate).toHaveBeenCalledWith({
      where: { id: "doc1" },
      data: { aclSubjects: JSON.stringify(subjects) },
    });
    expect(knowledgeChunkUpdateMany).toHaveBeenCalledWith({
      where: { documentId: "doc1" },
      data: { aclSubjects: JSON.stringify(subjects) },
    });
  });
});
