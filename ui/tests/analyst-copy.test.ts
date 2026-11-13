/**
 * #2337 — server status lines are shown in the words the controls now use.
 */
import { describe, expect, it } from "vitest";
import { analystCopy } from "@/lib/analyst-copy";
import { terminalToastText } from "@/lib/terminal-toast";

describe("analystCopy (#2337)", () => {
  it.each([
    [
      "Deep ingest complete: 10 of 12 files parsed.",
      "Full re-read complete: 10 of 12 files parsed.",
    ],
    [
      "Deep ingest completed with 2 failures: 2 source files could not be ingested.",
      "Full re-read completed with 2 failures: 2 source files could not be ingested.",
    ],
    [
      "Deep ingest complete: 8 of 10 files parsed, 150 symbols, 45 RAG chunks.",
      "Full re-read complete: 8 of 10 files parsed, 150 symbols, 45 sections indexed.",
    ],
    [
      "Sync completed with 2 failures: 2 source files could not be ingested. Automatic document regeneration was skipped; run Sync again to retry.",
      "Update completed with 2 failures: 2 source files could not be ingested. Automatic document regeneration was skipped; run Update again to retry.",
    ],
    ["the next Sync continues from there", "the next Update continues from there"],
  ])("rewrites %j", (input, expected) => {
    expect(analystCopy(input)).toBe(expected);
  });

  it("leaves every other sentence as the server wrote it", () => {
    const line = "Generated spec.md (v3) grounded on 8 retrieved sources. Synchronised.";
    expect(analystCopy(line)).toBe(line);
    // "Sync" only as the control's name, at the start or as "Sync again".
    expect(analystCopy("Issue Sync settings")).toBe("Issue Sync settings");
  });

  it("is applied to the terminal job toast", () => {
    const done = terminalToastText({
      jobId: "j",
      kind: "repo-ingest",
      status: "completed",
      message: "Deep ingest complete: 42",
      ts: 0,
    } as never);
    expect(done.text).toBe("Full re-read complete: 42");
    const failed = terminalToastText({
      jobId: "j",
      kind: "repo-ingest",
      status: "failed",
      error: "Deep ingest failed",
      ts: 0,
    } as never);
    expect(failed.text).toBe("Full re-read failed");
  });
});
