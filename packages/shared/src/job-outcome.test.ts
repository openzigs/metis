import { describe, expect, it } from "vitest";
import {
  JOB_SUBJECT_MAX,
  isAnnouncedJobKind,
  jobNotificationType,
  jobOutcomeHref,
  jobOutcomeMessage,
  jobOutcomeTitle,
  jobSubject,
  questionsWaitingLabel,
} from "./job-outcome.js";

describe("#2343 job outcome wording and links", () => {
  it("announces only analysis, document generation and ingest", () => {
    expect(isAnnouncedJobKind("analysis")).toBe(true);
    expect(isAnnouncedJobKind("doc-generation")).toBe(true);
    expect(isAnnouncedJobKind("document-ingest")).toBe(true);
    expect(isAnnouncedJobKind("spec-kit")).toBe(false);
    expect(isAnnouncedJobKind(undefined)).toBe(false);
  });

  it("stores each outcome under its own notification type", () => {
    expect(jobNotificationType("completed")).toBe("job_completed");
    expect(jobNotificationType("failed")).toBe("job_failed");
    expect(jobNotificationType("awaiting-review")).toBe("job_awaiting_review");
  });

  it("links each result to the page it lands on, ids encoded", () => {
    expect(jobOutcomeHref("analysis", "p1", "a 1", "completed")).toBe(
      "/projects/p1/analysis?analysisId=a%201",
    );
    expect(jobOutcomeHref("analysis", "p1", "a1", "failed")).toBe(
      "/projects/p1/analysis?analysisId=a1",
    );
    expect(jobOutcomeHref("doc-generation", "p1", "d1", "failed")).toBe(
      "/projects/p1/documentation?doc=d1",
    );
    expect(jobOutcomeHref("document-ingest", "p1", "d1", "completed")).toBe(
      "/projects/p1/documents",
    );
    expect(jobOutcomeHref("document-ingest", "p1", "d1", "failed")).toBe("/projects/p1/documents");
    expect(jobOutcomeHref("document-ingest", "p/1", "d1", "awaiting-review")).toBe(
      "/projects/p%2F1/settings#quarantine",
    );
  });

  it("flattens and cuts a name on a code point, never through an emoji", () => {
    expect(jobSubject("  Checkout\n\tredesign  ")).toBe("Checkout redesign");
    expect(jobSubject("")).toBeNull();
    expect(jobSubject("   ")).toBeNull();
    expect(jobSubject(null)).toBeNull();
    const exact = "a".repeat(JOB_SUBJECT_MAX);
    expect(jobSubject(exact)).toBe(exact);
    // Counted in code points: two emoji are four UTF-16 units but two characters.
    const emojiFits = "a".repeat(JOB_SUBJECT_MAX - 2) + "😀😀";
    expect(jobSubject(emojiFits)).toBe(emojiFits);
    const long = "a".repeat(JOB_SUBJECT_MAX - 2) + "😀😀😀";
    const cut = jobSubject(long)!;
    expect(Array.from(cut)).toHaveLength(JOB_SUBJECT_MAX);
    expect(cut.endsWith("😀…")).toBe(true);
  });

  it("names the job and its outcome in plain words", () => {
    expect(jobOutcomeTitle("analysis", "completed", "Checkout")).toBe(
      'Change request "Checkout" is ready',
    );
    expect(jobOutcomeTitle("analysis", "failed", "Checkout")).toBe(
      'Change request "Checkout" failed',
    );
    expect(jobOutcomeTitle("doc-generation", "completed", "Spec")).toBe('Document "Spec" is ready');
    expect(jobOutcomeTitle("doc-generation", "failed", "Spec")).toBe(
      'Document "Spec" failed to generate',
    );
    expect(jobOutcomeTitle("document-ingest", "completed", "a.pdf")).toBe(
      'Document "a.pdf" is ready to use',
    );
    expect(jobOutcomeTitle("document-ingest", "failed", "a.pdf")).toBe(
      'Document "a.pdf" could not be read',
    );
    expect(jobOutcomeTitle("document-ingest", "awaiting-review", "a.pdf")).toBe(
      'Document "a.pdf" is waiting for review',
    );
    expect(jobOutcomeTitle("analysis", "completed", null)).toBe("Your change request is ready");
  });

  it("says what to do next, with the open questions counted", () => {
    expect(questionsWaitingLabel(3)).toBe("Questions waiting (3)");
    expect(jobOutcomeMessage("analysis", "completed", 3)).toBe(
      "Questions waiting (3): open the change request to answer them.",
    );
    expect(jobOutcomeMessage("analysis", "completed")).toMatch(/review its requirements/);
    expect(jobOutcomeMessage("analysis", "failed")).toMatch(/failed.*start it again/);
    expect(jobOutcomeMessage("doc-generation", "failed")).toMatch(/regenerate/);
    expect(jobOutcomeMessage("doc-generation", "completed")).toMatch(/read it/);
    expect(jobOutcomeMessage("document-ingest", "failed")).toMatch(/upload it again/);
    expect(jobOutcomeMessage("document-ingest", "awaiting-review")).toMatch(/quarantine/);
    expect(jobOutcomeMessage("document-ingest", "completed")).toMatch(/searched/);
  });
});
