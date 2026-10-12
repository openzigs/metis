/**
 * #1064 (PR #1102 review, cycle 3) — what Generate sends for the publish batch
 * form's base URL field. The field is free text on another card: whatever it
 * holds, Generate is not refused for it.
 */
import { describe, expect, it } from "vitest";
import {
  BASE_URL_NOT_HTTPS,
  generateTargetBaseUrl,
  isHttpsUrl,
} from "@/lib/generate-target-base-url";

describe("generateTargetBaseUrl", () => {
  it("reads an empty field, or one holding only spaces, as public GitHub", () => {
    for (const field of ["", " ", "\t \n"]) {
      expect(generateTargetBaseUrl(field), JSON.stringify(field)).toEqual({
        value: null,
        problem: null,
      });
    }
  });

  it("sends an https URL trimmed, with nothing to say about it", () => {
    expect(generateTargetBaseUrl("  https://ghe.example.com/api/v3 \n")).toEqual({
      value: "https://ghe.example.com/api/v3",
      problem: null,
    });
    expect(generateTargetBaseUrl("HTTPS://api.github.com")).toEqual({
      value: "HTTPS://api.github.com",
      problem: null,
    });
  });

  it("sends anything else as typed, and says the drafts will list code as text", () => {
    for (const field of [
      "github.example.com",
      "http://ghe.example.com/api/v3",
      "https://",
      "https//ghe.example.com",
      "ghe example",
    ]) {
      expect(generateTargetBaseUrl(` ${field} `), field).toEqual({
        value: field,
        problem: BASE_URL_NOT_HTTPS,
      });
    }
    expect(BASE_URL_NOT_HTTPS).toContain("not an https URL");
  });

  it("isHttpsUrl accepts only a parseable https URL", () => {
    expect(isHttpsUrl("https://x.example")).toBe(true);
    expect(isHttpsUrl("http://x.example")).toBe(false);
    expect(isHttpsUrl("x.example")).toBe(false);
    expect(isHttpsUrl("")).toBe(false);
  });
});
