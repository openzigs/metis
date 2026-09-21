import { describe, it, expect } from "vitest";
import {
  isTruncationFinishReason,
  containsTruncationPlaceholder,
  stripTruncationPlaceholder,
  detectTruncation,
  describeTruncation,
  mergeTruncation,
} from "./truncation.js";

/** The body bedrock-access-gateway substitutes when Bedrock stops at the cap. */
const GATEWAY_PLACEHOLDER =
  "[No response text was returned by the model (stopReason=max_tokens). " +
  "The model's output was silently suppressed.]";

describe("isTruncationFinishReason (#1226)", () => {
  it("recognises the OpenAI-compatible 'length' stop reason", () => {
    expect(isTruncationFinishReason("length")).toBe(true);
  });

  it("recognises Anthropic's 'max_tokens' stop reason", () => {
    expect(isTruncationFinishReason("max_tokens")).toBe(true);
  });

  it("is case- and whitespace-insensitive", () => {
    expect(isTruncationFinishReason("  MAX_TOKENS ")).toBe(true);
    expect(isTruncationFinishReason("Length")).toBe(true);
  });

  it("does NOT treat a clean stop as truncation", () => {
    expect(isTruncationFinishReason("stop")).toBe(false);
    expect(isTruncationFinishReason("end_turn")).toBe(false);
    expect(isTruncationFinishReason("tool_use")).toBe(false);
  });

  it("treats an absent finish reason as not-truncated (absence of evidence)", () => {
    expect(isTruncationFinishReason(undefined)).toBe(false);
    expect(isTruncationFinishReason(null)).toBe(false);
    expect(isTruncationFinishReason("")).toBe(false);
  });
});

describe("containsTruncationPlaceholder (#1226)", () => {
  it("detects the gateway placeholder anywhere in the body", () => {
    expect(containsTruncationPlaceholder(`## Business Rules\n\n${GATEWAY_PLACEHOLDER}`)).toBe(true);
  });

  it("detects a placeholder that was itself cut off (no closing bracket)", () => {
    expect(containsTruncationPlaceholder("[No response text was returned by the model")).toBe(true);
  });

  it("detects a bare stopReason=max_tokens marker with no bracketed sentence", () => {
    expect(containsTruncationPlaceholder("...rule BR-14. stopReason=max_tokens")).toBe(true);
  });

  it("does not fire on ordinary section prose", () => {
    expect(
      containsTruncationPlaceholder(
        "## Business Rules\n\nThe model returns a response for each batch.",
      ),
    ).toBe(false);
  });

  it("is stateless across repeated calls (no sticky regex lastIndex)", () => {
    const text = `x ${GATEWAY_PLACEHOLDER} y`;
    expect(containsTruncationPlaceholder(text)).toBe(true);
    expect(containsTruncationPlaceholder(text)).toBe(true);
    expect(containsTruncationPlaceholder(text)).toBe(true);
  });
});

describe("stripTruncationPlaceholder (#1226)", () => {
  it("removes the placeholder so it can never reach persisted content", () => {
    const stripped = stripTruncationPlaceholder(
      `## Business Rules\n\n- BR-1 applies.\n\n${GATEWAY_PLACEHOLDER}`,
    );
    expect(stripped).not.toContain("No response text was returned");
    expect(stripped).not.toContain("stopReason=max_tokens");
    expect(stripped).toContain("- BR-1 applies.");
  });

  it("collapses the whitespace the removal leaves behind", () => {
    const stripped = stripTruncationPlaceholder(`# T\n\n${GATEWAY_PLACEHOLDER}\n\n\nBody`);
    expect(stripped).toBe("# T\n\nBody");
  });

  it("strips a placeholder-only body down to the empty string", () => {
    expect(stripTruncationPlaceholder(GATEWAY_PLACEHOLDER)).toBe("");
  });

  it("leaves clean prose untouched", () => {
    const clean = "## Key Workflows\n\nStep 1 loads the batch.";
    expect(stripTruncationPlaceholder(clean)).toBe(clean);
  });
});

describe("detectTruncation (#1226)", () => {
  it("detects truncation from the finish reason alone (mid-sentence cut)", () => {
    const d = detectTruncation("## Business Rules\n\n- BR-1 applies when the batch", "length");
    expect(d.truncated).toBe(true);
    expect(d.signals.finishReason).toBe(true);
    expect(d.signals.placeholder).toBe(false);
    expect(d.reason).toBe("length");
    // Nothing to strip — the partial prose is kept, only flagged.
    expect(d.text).toContain("BR-1 applies");
  });

  it("detects truncation from the placeholder alone (no finish reason forwarded)", () => {
    const d = detectTruncation(`## Business Rules\n\n${GATEWAY_PLACEHOLDER}`, undefined);
    expect(d.truncated).toBe(true);
    expect(d.signals.placeholder).toBe(true);
    expect(d.signals.finishReason).toBe(false);
    expect(d.text).not.toContain("No response text was returned");
  });

  it("detects truncation when BOTH signals fire and still strips the placeholder", () => {
    const d = detectTruncation(`## Rules\n\n${GATEWAY_PLACEHOLDER}`, "max_tokens");
    expect(d.truncated).toBe(true);
    expect(d.signals).toEqual({ finishReason: true, placeholder: true });
    expect(d.text).toBe("## Rules");
  });

  it("reports a clean response as not truncated and passes the text through", () => {
    const text = "## Rules\n\n- BR-1 applies.";
    const d = detectTruncation(text, "stop");
    expect(d.truncated).toBe(false);
    expect(d.text).toBe(text);
    expect(d.reason).toBe("stop");
  });

  it("omits `reason` entirely when the provider reported none", () => {
    expect(detectTruncation("ok", undefined).reason).toBeUndefined();
    expect(detectTruncation("ok", "").reason).toBeUndefined();
  });
});

describe("describeTruncation (#1226)", () => {
  it("names the finish-reason signal", () => {
    expect(describeTruncation(detectTruncation("x", "length"))).toContain("length");
  });

  it("names the placeholder signal", () => {
    expect(describeTruncation(detectTruncation(GATEWAY_PLACEHOLDER))).toContain("placeholder");
  });

  it("names both signals when both fired", () => {
    const d = describeTruncation(detectTruncation(GATEWAY_PLACEHOLDER, "max_tokens"));
    expect(d).toContain("max_tokens");
    expect(d).toContain("placeholder");
  });

  it("falls back to a stable string when nothing fired", () => {
    expect(describeTruncation(detectTruncation("clean", "stop"))).toBe("unknown truncation signal");
  });
});

describe("mergeTruncation (#1226)", () => {
  it("reports a truncated refine even when the draft finished cleanly", () => {
    const merged = mergeTruncation(
      detectTruncation("clean draft", "stop"),
      detectTruncation("cut refine", "length"),
    );
    expect(merged.truncated).toBe(true);
    expect(merged.reason).toBe("length");
    expect(merged.signals.finishReason).toBe(true);
  });

  it("keeps a truncated draft's verdict when the refine finished cleanly", () => {
    const merged = mergeTruncation(
      detectTruncation("cut draft", "max_tokens"),
      detectTruncation("clean refine", "stop"),
    );
    expect(merged.truncated).toBe(true);
    expect(merged.reason).toBe("max_tokens");
  });

  it("unions the two independent signals", () => {
    const merged = mergeTruncation(
      detectTruncation(GATEWAY_PLACEHOLDER),
      detectTruncation("cut refine", "length"),
    );
    expect(merged.signals).toEqual({ finishReason: true, placeholder: true });
  });

  it("stays clean when neither call was truncated", () => {
    const merged = mergeTruncation(
      detectTruncation("clean draft", "stop"),
      detectTruncation("clean refine", "stop"),
    );
    expect(merged.truncated).toBe(false);
    expect(merged.text).toBe("clean refine");
  });
});
