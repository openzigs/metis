import { describe, expect, it } from "vitest";
import {
  isPreResponseNetworkFailure,
  isSharedWebhookEligible,
  isTransientGithubFailure,
  repoPermissionDto,
  repoPermissionOf,
} from "./repo-permission.js";

describe("#1488 repoPermissionOf", () => {
  it("is none for an unauthenticated read, whatever GitHub says", () => {
    expect(repoPermissionOf(false, undefined)).toBe("none");
    expect(repoPermissionOf(false, { admin: true, push: true })).toBe("none");
  });

  it("reads the strongest permission GitHub reports for a token", () => {
    expect(repoPermissionOf(true, { admin: true, push: true, pull: true })).toBe("admin");
    expect(repoPermissionOf(true, { admin: false, push: true, pull: true })).toBe("push");
    expect(repoPermissionOf(true, { admin: false, maintain: true, push: false })).toBe("push");
    expect(repoPermissionOf(true, { admin: false, push: false, pull: true })).toBe("read");
    expect(repoPermissionOf(true, { triage: true })).toBe("read");
  });

  it("is unknown for a token GitHub reports no permissions for", () => {
    expect(repoPermissionOf(true, undefined)).toBe("unknown");
    expect(repoPermissionOf(true, null)).toBe("unknown");
    expect(isSharedWebhookEligible("unknown")).toBe(false);
  });
});

describe("#1488 isSharedWebhookEligible", () => {
  it.each([
    ["admin", true],
    ["push", true],
    ["read", false],
    ["none", false],
    [null, false],
    [undefined, false],
    ["ADMIN", false],
  ] as const)("%s → %s", (permission, eligible) => {
    expect(isSharedWebhookEligible(permission)).toBe(eligible);
  });
});

describe("#1488 repoPermissionDto", () => {
  it("passes the four recorded values and nulls anything else", () => {
    for (const v of ["admin", "push", "read", "unknown", "none"])
      expect(repoPermissionDto(v)).toBe(v);
    expect(repoPermissionDto(null)).toBeNull();
    expect(repoPermissionDto(undefined)).toBeNull();
    expect(repoPermissionDto("owner")).toBeNull();
  });
});

describe("#1488 isTransientGithubFailure", () => {
  const httpError = (status: number, message = "x", headers: Record<string, unknown> = {}) =>
    Object.assign(new Error(message), { status, response: { headers } });

  it("a primary rate limit (remaining 0) is transient", () => {
    expect(
      isTransientGithubFailure(httpError(403, "Forbidden", { "x-ratelimit-remaining": "0" })),
    ).toBe(true);
    expect(
      isTransientGithubFailure(httpError(403, "Forbidden", { "x-ratelimit-remaining": 0 })),
    ).toBe(true);
  });

  it("a secondary rate limit (retry-after, or the message) is transient", () => {
    expect(isTransientGithubFailure(httpError(403, "Forbidden", { "retry-after": "60" }))).toBe(
      true,
    );
    expect(
      isTransientGithubFailure(httpError(403, "You have exceeded a secondary rate limit")),
    ).toBe(true);
    expect(isTransientGithubFailure(httpError(429, "Too Many Requests"))).toBe(true);
  });

  it("a 5xx (which is also how Octokit reports a failed fetch) is transient", () => {
    expect(isTransientGithubFailure(httpError(500))).toBe(true);
    expect(isTransientGithubFailure(httpError(502))).toBe(true);
    expect(isTransientGithubFailure(httpError(503))).toBe(true);
  });

  it("with no HTTP status, only an aborted request is transient", () => {
    const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
    expect(isTransientGithubFailure(abort)).toBe(true);
    // Not GitHub failures: a database error after the request, a bad response shape.
    expect(isTransientGithubFailure(new Error("ECONNRESET"))).toBe(false);
    expect(isTransientGithubFailure(new TypeError("cannot read 'default_branch'"))).toBe(false);
  });

  it("a 403 that is not a rate limit is a refusal of the credential", () => {
    expect(
      isTransientGithubFailure(
        httpError(403, "Resource protected by organization SAML enforcement", {
          "x-ratelimit-remaining": "4999",
        }),
      ),
    ).toBe(false);
    expect(isTransientGithubFailure(httpError(403, "Forbidden"))).toBe(false);
  });

  it("401, 404 and other 4xx are never transient", () => {
    expect(isTransientGithubFailure(httpError(401, "Bad credentials"))).toBe(false);
    expect(isTransientGithubFailure(httpError(404, "Not Found"))).toBe(false);
    expect(isTransientGithubFailure(httpError(422, "Unprocessable"))).toBe(false);
  });

  it("is false for something that is not an error object", () => {
    expect(isTransientGithubFailure(null)).toBe(false);
    expect(isTransientGithubFailure("boom")).toBe(false);
  });
});

describe("#1499 isPreResponseNetworkFailure", () => {
  const coded = (code: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(code), { code, ...extra });

  it("is true for the host allow-list's DNS failures, which carry a 502", () => {
    expect(isPreResponseNetworkFailure(coded("DNS_LOOKUP_FAILED", { status: 502 }))).toBe(true);
    expect(isPreResponseNetworkFailure(coded("DNS_LOOKUP_EMPTY", { status: 502 }))).toBe(true);
  });

  it.each(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_SOCKET"])(
    "is true for %s, raised directly or as a failed fetch's cause",
    (code) => {
      expect(isPreResponseNetworkFailure(coded(code))).toBe(true);
      const fetchFailed = Object.assign(new TypeError("fetch failed"), { cause: coded(code) });
      expect(isPreResponseNetworkFailure(fetchFailed)).toBe(true);
    },
  );

  it("is false for a refusal this server raised itself", () => {
    expect(isPreResponseNetworkFailure(coded("HOST_NOT_ALLOWED", { status: 403 }))).toBe(false);
    expect(isPreResponseNetworkFailure(coded("PIN_UNAVAILABLE", { status: 500 }))).toBe(false);
  });

  it("is false for any HTTP answer, even one whose cause names a network code", () => {
    expect(isPreResponseNetworkFailure(coded("ECONNRESET", { status: 500 }))).toBe(false);
    const answered = Object.assign(new Error("Bad credentials"), {
      status: 401,
      cause: coded("ECONNRESET"),
    });
    expect(isPreResponseNetworkFailure(answered)).toBe(false);
  });

  it("is false for anything else", () => {
    expect(isPreResponseNetworkFailure(new TypeError("cannot read 'x'"))).toBe(false);
    expect(isPreResponseNetworkFailure(coded("EACCES"))).toBe(false);
    expect(isPreResponseNetworkFailure(null)).toBe(false);
    expect(isPreResponseNetworkFailure("ECONNRESET")).toBe(false);
  });
});
