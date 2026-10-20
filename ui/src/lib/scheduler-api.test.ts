import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/api-client";
import { JOB_VERSION_CONFLICT, jobEditInput, jobSaveErrorMessage } from "./scheduler-api";

describe("jobEditInput (#1245)", () => {
  it("sends the version the form was opened with as expectedVersion, with every form field", () => {
    const fields = {
      name: "Renamed",
      cron: "0 3 * * *",
      taskType: "http-webhook",
      payload: { url: "https://hooks.example/in" },
      enabled: false,
      maxAttempts: 2,
    };
    expect(jobEditInput({ version: 7 }, fields)).toEqual({ ...fields, expectedVersion: 7 });
  });

  it("sends version 0 too: a job never edited still carries its precondition", () => {
    expect(jobEditInput({ version: 0 }, { name: "x" })).toEqual({
      name: "x",
      expectedVersion: 0,
    });
  });
});

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
