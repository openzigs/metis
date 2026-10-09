// #964 — the control: passes on its first attempt, so nothing is flagged.
import { expect, it } from "vitest";

it("passes first time", () => {
  expect(2).toBe(2);
});
