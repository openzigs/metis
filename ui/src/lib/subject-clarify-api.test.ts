/** #2270 — the subject dialog's endpoints: one per result kind, the id encoded, answers only. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/api-client", () => ({ apiFetch }));

const { subjectClarifyApi } = await import("./subject-clarify-api");

beforeEach(() => apiFetch.mockClear());

describe("#2270 — subjectClarifyApi", () => {
  it("reads, starts and submits on the result's own clarify endpoint", async () => {
    await subjectClarifyApi.get("impact", "ia/1");
    await subjectClarifyApi.start("portfolio", "pa-1");
    await subjectClarifyApi.submit("impact", "ia-1", [{ questionId: "q1", answer: "EU" }]);
    expect(apiFetch.mock.calls).toEqual([
      ["/impact-analyses/ia%2F1/clarify"],
      ["/portfolio-assessments/pa-1/clarify", { method: "POST", body: {} }],
      [
        "/impact-analyses/ia-1/clarify",
        { method: "POST", body: { answers: [{ questionId: "q1", answer: "EU" }] } },
      ],
    ]);
  });
});
