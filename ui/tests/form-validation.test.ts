/**
 * Unit tests for the friendly form-validation helpers (#426).
 *
 * Covers the server-error → inline-message mapping and the client-side
 * required-field checks that drive disabled-submit + inline errors.
 */
import { describe, it, expect } from "vitest";
import { ApiError } from "@/lib/api-client";
import { hasRequiredValues, mapFieldErrors, requiredFieldErrors } from "@/lib/form-validation";

describe("mapFieldErrors", () => {
  it("maps the server's details.fields summary to a { field: message } map", () => {
    const err = new ApiError(400, "Some fields need your attention", "VALIDATION_ERROR", {
      fields: [
        { field: "owner", message: "owner is required" },
        { field: "repo", message: "repo is required" },
      ],
    });
    expect(mapFieldErrors(err)).toEqual({
      owner: "owner is required",
      repo: "repo is required",
    });
  });

  it("keeps the FIRST message when a field appears twice", () => {
    const err = new ApiError(400, "bad", "VALIDATION_ERROR", {
      fields: [
        { field: "owner", message: "owner is required" },
        { field: "owner", message: "owner is too short" },
      ],
    });
    expect(mapFieldErrors(err)).toEqual({ owner: "owner is required" });
  });

  it("returns an empty map for a non-ApiError", () => {
    expect(mapFieldErrors(new Error("boom"))).toEqual({});
    expect(mapFieldErrors("nope")).toEqual({});
    expect(mapFieldErrors(undefined)).toEqual({});
  });

  it("returns an empty map when details has no fields array", () => {
    expect(mapFieldErrors(new ApiError(400, "x", "VALIDATION_ERROR", { other: 1 }))).toEqual({});
    expect(mapFieldErrors(new ApiError(400, "x", "VALIDATION_ERROR"))).toEqual({});
  });

  it("ignores malformed entries (defends against a non-{field,message} payload)", () => {
    const err = new ApiError(400, "x", "VALIDATION_ERROR", {
      fields: [{ field: "owner", message: "owner is required" }, { nope: true }, 42, null],
    });
    expect(mapFieldErrors(err)).toEqual({ owner: "owner is required" });
  });

  it("never surfaces raw Zod tokens — it only reads the safe summary", () => {
    // Even if (hypothetically) a raw issue leaked into details, the helper only
    // reads `{field, message}` entries, so raw tokens never reach the UI map.
    const err = new ApiError(400, "x", "VALIDATION_ERROR", {
      fields: [{ code: "too_small", path: ["owner"], minimum: 1 } as never],
    });
    expect(mapFieldErrors(err)).toEqual({});
  });
});

describe("requiredFieldErrors", () => {
  it("flags empty and whitespace-only required fields with a friendly message", () => {
    expect(
      requiredFieldErrors({ name: "", slug: "   " }, ["name", "slug"], {
        name: "Name",
        slug: "Slug",
      }),
    ).toEqual({ name: "Name is required", slug: "Slug is required" });
  });

  it("returns no errors when all required fields are filled", () => {
    expect(requiredFieldErrors({ name: "Acme", slug: "acme" }, ["name", "slug"])).toEqual({});
  });

  it("falls back to the raw key when no label is provided", () => {
    expect(requiredFieldErrors({ name: "" }, ["name"])).toEqual({ name: "name is required" });
  });

  it("treats a missing (undefined) value as empty", () => {
    expect(requiredFieldErrors({}, ["name"], { name: "Name" })).toEqual({
      name: "Name is required",
    });
  });
});

describe("hasRequiredValues", () => {
  it("is false when any required field is empty/whitespace", () => {
    expect(hasRequiredValues({ name: "Acme", slug: "" }, ["name", "slug"])).toBe(false);
    expect(hasRequiredValues({ name: "  ", slug: "acme" }, ["name", "slug"])).toBe(false);
  });

  it("is true when every required field has a non-empty trimmed value", () => {
    expect(hasRequiredValues({ name: "Acme", slug: "acme" }, ["name", "slug"])).toBe(true);
  });

  it("is true when there are no required fields", () => {
    expect(hasRequiredValues({}, [])).toBe(true);
  });
});
