/**
 * #2222 — the wording **Re-check this requirement** checks. The route, the
 * scoping and the store are exercised end to end in
 * `tests/governing-recheck-2222.sqlite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { requirementWording } from "./recheck.js";

describe("requirementWording", () => {
  it("is the title, the body and the acceptance criteria, as one text", () => {
    expect(
      requirementWording({
        title: "Minimum password length",
        body: " Passwords are at least 15 characters, or 8 with MFA. ",
        acceptanceCriteria: JSON.stringify([
          "A 14-character password is refused.",
          "MFA allows 8.",
        ]),
      }),
    ).toBe(
      "Minimum password length\n\nPasswords are at least 15 characters, or 8 with MFA.\n\nAcceptance criteria:\n- A 14-character password is refused.\n- MFA allows 8.",
    );
  });

  it("leaves out an empty body and absent criteria", () => {
    expect(requirementWording({ title: "Title", body: "  ", acceptanceCriteria: null })).toBe(
      "Title",
    );
    expect(requirementWording({ title: "Title", body: "Body", acceptanceCriteria: "[]" })).toBe(
      "Title\n\nBody",
    );
  });
});
