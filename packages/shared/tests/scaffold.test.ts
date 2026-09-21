import { describe, expect, it } from "vitest";
import { SHARED_PACKAGE_NAME, describePackage } from "../src/index.js";

describe("@metis/shared scaffold", () => {
  it("exposes the package name", () => {
    expect(SHARED_PACKAGE_NAME).toBe("@metis/shared");
  });

  it("formats package metadata", () => {
    expect(describePackage({ name: "foo", version: "1.2.3" })).toBe("foo@1.2.3");
  });
});
