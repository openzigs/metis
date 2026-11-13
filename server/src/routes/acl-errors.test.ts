/**
 * #2356 — the HTTP form of the document-ACL errors, now kept beside the routes
 * so `lib/rag/acl.ts` carries no HTTP status.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../lib/prisma.js", () => ({ prisma: {} }));

const { aclSaveErrorAsHttp, inactiveCallerAsUnauthenticated } = await import("./acl-errors.js");
const { AclGroupUnsupportedError, AclSaveConflictError, InactiveAclActorError } =
  await import("../lib/rag/acl.js");
const { AppError } = await import("../middleware/error-handler.js");

describe("aclSaveErrorAsHttp", () => {
  it("is a 400 ACL_GROUP_UNSUPPORTED naming the groups", () => {
    const err = aclSaveErrorAsHttp(new AclGroupUnsupportedError(["finance"]));
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      statusCode: 400,
      code: "ACL_GROUP_UNSUPPORTED",
      details: { groups: ["finance"] },
    });
  });

  it("is a 409 ACL_CONFLICT for a save that kept losing the race", () => {
    expect(aclSaveErrorAsHttp(new AclSaveConflictError())).toMatchObject({
      statusCode: 409,
      code: "ACL_CONFLICT",
    });
  });

  it("returns any other error unchanged", () => {
    const other = new Error("db down");
    expect(aclSaveErrorAsHttp(other)).toBe(other);
  });
});

describe("inactiveCallerAsUnauthenticated", () => {
  it("is a 401 TOKEN_INVALID for an inactive caller, and leaves any other error alone", () => {
    expect(inactiveCallerAsUnauthenticated(new InactiveAclActorError())).toMatchObject({
      statusCode: 401,
      code: "TOKEN_INVALID",
    });
    const other = new Error("db down");
    expect(inactiveCallerAsUnauthenticated(other)).toBe(other);
  });
});
