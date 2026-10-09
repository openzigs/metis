// #964 — a deliberately leaky test: it fails on its first attempt and passes on
// the retry, which is exactly what `retry: 2` hid for #963's leaked mock
// once-value. The module-level counter survives the retry, as leaked mock state
// does.
import { describe, expect, it } from "vitest";

let attempts = 0;

describe("leaky", () => {
  it("passes only on the second attempt", () => {
    attempts += 1;
    expect(attempts).toBeGreaterThan(1);
  });

  it("passes first time", () => {
    expect(1).toBe(1);
  });
});
