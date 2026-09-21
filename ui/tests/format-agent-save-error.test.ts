/**
 * #470 (epic #459) — formatLibrarySaveError extracts the specific reason from
 * an ApiError instead of the generic envelope message.
 */
import { describe, it, expect } from "vitest";
import { formatLibrarySaveError } from "@/lib/format-agent-save-error";
import { ApiError } from "@/lib/api-client";

describe("formatLibrarySaveError", () => {
  it("returns the fallback for a non-ApiError", () => {
    expect(formatLibrarySaveError(new Error("boom"))).toBe("Save failed");
    expect(formatLibrarySaveError("nope", "custom")).toBe("custom");
  });

  it("surfaces Zod flatten fieldErrors from the payload schema", () => {
    const err = new ApiError(400, "Invalid agent payload", "VALIDATION_ERROR", {
      issues: {
        fieldErrors: { source: ["String must contain at least 3 character(s)"] },
        formErrors: [],
      },
    });
    expect(formatLibrarySaveError(err)).toBe("source: String must contain at least 3 character(s)");
  });

  it("surfaces friendly field errors from the central mapper", () => {
    const err = new ApiError(400, "Some fields need attention", "VALIDATION_ERROR", {
      fields: [{ field: "name", message: "name is required" }],
    });
    expect(formatLibrarySaveError(err)).toBe("name: name is required");
  });

  it("falls back to the specific server message (e.g. a FrontmatterError)", () => {
    const err = new ApiError(
      400,
      "[VALIDATION_ERROR] Agent frontmatter failed validation: name: Required",
      "VALIDATION_ERROR",
      undefined,
    );
    expect(formatLibrarySaveError(err)).toMatch(/name: Required/);
  });

  it("includes formErrors when present", () => {
    const err = new ApiError(400, "bad", "VALIDATION_ERROR", {
      issues: { fieldErrors: {}, formErrors: ["Top-level problem"] },
    });
    expect(formatLibrarySaveError(err)).toBe("Top-level problem");
  });
});
