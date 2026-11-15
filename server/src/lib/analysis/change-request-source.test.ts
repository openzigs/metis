/**
 * #2548 — a change request with nothing for its reader to check says why: no
 * requirement yet, or every one resting on a source the reader cannot see.
 */
import { describe, expect, it } from "vitest";
import { ALL_REQUIREMENTS_RESTRICTED_MESSAGE } from "@metis/shared";
import { assertHasRequirements, type ChangeRequestSource } from "./change-request-source.js";

const source = (over: Partial<ChangeRequestSource>): ChangeRequestSource => ({
  id: "cr-1",
  projectId: "p-1",
  title: "Payroll change",
  requirements: [],
  restrictedLeftOut: 0,
  ...over,
});

const refusal = (s: ChangeRequestSource) => {
  try {
    assertHasRequirements(s);
    return null;
  } catch (err) {
    return err as { statusCode: number; code: string; message: string };
  }
};

describe("assertHasRequirements (#2548)", () => {
  it("passes a change request with a requirement to check", () => {
    const one = {
      id: "r1",
      title: "Pay",
      body: "",
      acceptanceCriteria: null,
      approved: false,
      sourceIds: null,
    };
    expect(refusal(source({ requirements: [one], restrictedLeftOut: 3 }))).toBeNull();
  });

  it("says there are none yet when the change request holds none", () => {
    expect(refusal(source({}))).toMatchObject({
      statusCode: 400,
      code: "NO_REQUIREMENTS",
      message: "This change request has no draft or approved requirements to check yet.",
    });
  });

  it("says the reader's access left every one out, without naming any", () => {
    const err = refusal(source({ restrictedLeftOut: 20 }));
    expect(err).toMatchObject({ statusCode: 400, code: "NO_REQUIREMENTS" });
    expect(err!.message).toBe(ALL_REQUIREMENTS_RESTRICTED_MESSAGE);
    expect(err!.message).not.toContain("Payroll");
  });
});
