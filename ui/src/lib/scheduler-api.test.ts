import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client";
import { JOB_VERSION_CONFLICT, jobSaveErrorMessage } from "./scheduler-api";

describe("jobSaveErrorMessage (#1245)", () => {
  it("tells the user plainly that someone else changed the job and what to do", () => {
    const msg = jobSaveErrorMessage(
      new ApiError(409, "scheduled job j1 was changed by someone else", JOB_VERSION_CONFLICT),
    );
    expect(msg).toMatch(/Someone else changed this job after you opened it/);
    expect(msg).toMatch(/not saved/);
    expect(msg).toMatch(/open the job again/);
  });

  it("shows any other API error's own message", () => {
    expect(jobSaveErrorMessage(new ApiError(400, "cron too frequent", "INVALID_CRON"))).toBe(
      "cron too frequent",
    );
    expect(jobSaveErrorMessage(new ApiError(409, "other conflict", "SOMETHING_ELSE"))).toBe(
      "other conflict",
    );
  });

  it("falls back for a plain error and for a non-error", () => {
    expect(jobSaveErrorMessage(new Error("payload is not valid JSON"))).toBe(
      "payload is not valid JSON",
    );
    expect(jobSaveErrorMessage("boom")).toBe("Failed to save");
  });
});
