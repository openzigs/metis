import { describe, expect, it } from "vitest";
import { bindingTypeLabel } from "./vault-binding-summary";

describe("bindingTypeLabel", () => {
  it("names a scheduled webhook job (#1243)", () => {
    expect(bindingTypeLabel("scheduled_webhook_job")).toBe("Scheduled webhook job");
  });

  it("shows an unknown type as itself", () => {
    expect(bindingTypeLabel("something_new")).toBe("something_new");
  });
});
