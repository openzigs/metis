/**
 * Unit tests for the SC 3.3.3 Error Suggestion helpers — Issue #663.
 *
 * Each helper turns a detectable-cause input error into a message that suggests
 * a concrete correction, or falls back to an actionable format statement when no
 * suggestion is derivable.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeSlug,
  slugSuggestionMessage,
  workspaceSlugSuggestionMessage,
  httpUrlSuggestion,
  isHttpUrl,
  urlSuggestionMessage,
  urlProtocolSuggestionMessage,
  webhookUrlSuggestionMessage,
  amountSuggestionMessage,
  unsupportedFileTypeMessage,
  editDistance,
  isLikelyEmail,
  suggestEmail,
  emailSuggestionMessage,
} from "@/lib/error-suggestion";

describe("normalizeSlug", () => {
  it("lowercases and hyphenates non-alphanumerics", () => {
    expect(normalizeSlug("My Project")).toBe("my-project");
    expect(normalizeSlug("Foo__Bar!!Baz")).toBe("foo-bar-baz");
  });

  it("collapses runs and trims leading/trailing hyphens", () => {
    expect(normalizeSlug("  --Hello -- World--  ")).toBe("hello-world");
  });

  it("returns empty when nothing usable remains", () => {
    expect(normalizeSlug("   ")).toBe("");
    expect(normalizeSlug("!!!")).toBe("");
  });
});

describe("slugSuggestionMessage", () => {
  it("suggests the normalized slug verbatim", () => {
    expect(slugSuggestionMessage("My Project")).toContain("“my-project”");
    expect(slugSuggestionMessage("My Project")).toMatch(/lowercase letters, numbers, and hyphens/i);
  });

  it("falls back to the format statement when nothing derivable", () => {
    const msg = slugSuggestionMessage("!!!");
    expect(msg).toMatch(/lowercase letters, numbers, and hyphens/i);
    expect(msg).toContain("my-project");
  });
});

describe("workspaceSlugSuggestionMessage", () => {
  it("suggests the normalized slug when it satisfies the ≥2-char workspace rule", () => {
    const msg = workspaceSlugSuggestionMessage("My Workspace");
    expect(msg).toContain("“my-workspace”");
    expect(msg).toMatch(/lowercase letters, numbers, and hyphens/i);
  });

  it("does NOT suggest a single-char normalization that would fail the workspace rule", () => {
    // "a!" normalizes to "a" — valid for a project slug but rejected by the
    // workspace pattern (needs a leading AND trailing alphanumeric). Suggesting
    // it would just get rejected again, so we state the requirement instead.
    const msg = workspaceSlugSuggestionMessage("a!");
    expect(msg).not.toContain("“a”");
    expect(msg).toMatch(/at least two characters/i);
  });

  it("falls back to the requirement statement when nothing derivable", () => {
    const msg = workspaceSlugSuggestionMessage("!!!");
    expect(msg).toMatch(/at least two characters/i);
    expect(msg).toContain("my-workspace");
  });
});

describe("httpUrlSuggestion", () => {
  it("prefixes a scheme-less host that looks real", () => {
    expect(httpUrlSuggestion("example.com/page")).toBe("https://example.com/page");
  });

  it("swaps an unsupported scheme to https", () => {
    expect(httpUrlSuggestion("ftp://example.com/file.md")).toBe("https://example.com/file.md");
  });

  it("returns null for an already-valid http(s) URL", () => {
    expect(httpUrlSuggestion("https://example.com")).toBeNull();
    expect(httpUrlSuggestion("http://internal/doc")).toBeNull();
  });

  it("returns null when nothing safe is derivable", () => {
    expect(httpUrlSuggestion("not-a-url")).toBeNull();
    expect(httpUrlSuggestion("   ")).toBeNull();
  });
});

describe("isHttpUrl", () => {
  it("accepts valid http(s) URLs", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("  http://internal/x  ")).toBe(true);
  });

  it("rejects non-http schemes and malformed values", () => {
    expect(isHttpUrl("ftp://example.com")).toBe(false);
    expect(isHttpUrl("example.com")).toBe(false);
    expect(isHttpUrl("garbage")).toBe(false);
  });
});

describe("urlSuggestionMessage", () => {
  it("includes a derived suggestion when possible", () => {
    expect(urlSuggestionMessage("example.com/page")).toContain("“https://example.com/page”");
  });

  it("states the expected format when nothing derivable", () => {
    expect(urlSuggestionMessage("not-a-url")).toMatch(/valid http\(s\) URL/i);
    expect(urlSuggestionMessage("not-a-url")).toContain("https://example.com/page");
  });
});

describe("urlProtocolSuggestionMessage", () => {
  it("suggests the https-swapped URL", () => {
    expect(urlProtocolSuggestionMessage("ftp://example.com/file.md")).toContain(
      "“https://example.com/file.md”",
    );
    expect(urlProtocolSuggestionMessage("ftp://example.com/file.md")).toMatch(
      /http and https URLs are supported/i,
    );
  });

  it("falls back when no suggestion derivable", () => {
    expect(urlProtocolSuggestionMessage("mailto:")).toMatch(/http and https URLs are supported/i);
  });
});

describe("webhookUrlSuggestionMessage", () => {
  it("suggests a corrected webhook URL", () => {
    expect(webhookUrlSuggestionMessage("hooks.example.com/abc")).toContain(
      "“https://hooks.example.com/abc”",
    );
  });

  it("states the format when nothing derivable", () => {
    expect(webhookUrlSuggestionMessage("garbage")).toMatch(
      /valid webhook URL starting with https/i,
    );
  });
});

describe("amountSuggestionMessage", () => {
  it("suggests the cleaned non-negative value", () => {
    expect(amountSuggestionMessage("-50")).toContain("try 50");
    expect(amountSuggestionMessage("$1,000")).toContain("try 1000");
  });

  it("states the format when not a number", () => {
    expect(amountSuggestionMessage("abc")).toMatch(/non-negative amount, e\.g\./i);
  });
});

describe("unsupportedFileTypeMessage", () => {
  it("lists the accepted extensions without leading dots", () => {
    const msg = unsupportedFileTypeMessage(["md", ".txt", "pdf"]);
    expect(msg).toMatch(/Unsupported file type/i);
    expect(msg).toContain("md, txt, pdf");
  });
});

describe("editDistance", () => {
  it("computes basic distances", () => {
    expect(editDistance("", "abc")).toBe(3);
    expect(editDistance("abc", "")).toBe(3);
    expect(editDistance("gmail.com", "gmail.com")).toBe(0);
    expect(editDistance("gmial.com", "gmail.com")).toBe(2);
    expect(editDistance("gmai.com", "gmail.com")).toBe(1);
  });
});

describe("isLikelyEmail", () => {
  it("accepts a well-formed address", () => {
    expect(isLikelyEmail("name@example.com")).toBe(true);
  });

  it("rejects malformed addresses", () => {
    expect(isLikelyEmail("name-at-example.com")).toBe(false);
    expect(isLikelyEmail("name@localhost")).toBe(false);
    expect(isLikelyEmail("name@")).toBe(false);
  });
});

describe("suggestEmail", () => {
  it("corrects a close domain typo", () => {
    expect(suggestEmail("user@gmial.com")).toBe("user@gmail.com");
    expect(suggestEmail("user@gmai.com")).toBe("user@gmail.com");
    expect(suggestEmail("user@hotmial.com")).toBe("user@hotmail.com");
  });

  it("returns null for an already-good domain", () => {
    expect(suggestEmail("user@gmail.com")).toBeNull();
  });

  it("returns null when there is no local part or no @", () => {
    expect(suggestEmail("@gmail.com")).toBeNull();
    expect(suggestEmail("plainstring")).toBeNull();
    expect(suggestEmail("user@")).toBeNull();
  });

  it("returns null when the domain is not close to any known provider", () => {
    expect(suggestEmail("user@corp-internal.example")).toBeNull();
  });
});

describe("emailSuggestionMessage", () => {
  it("suggests the corrected address for a domain typo", () => {
    expect(emailSuggestionMessage("user@gmial.com")).toContain("“user@gmail.com”");
  });

  it("prompts for an @ when missing", () => {
    expect(emailSuggestionMessage("user.example.com")).toMatch(/include an “@”/);
  });

  it("states the format when no suggestion and @ present", () => {
    expect(emailSuggestionMessage("user@localhost")).toMatch(/valid email address, e\.g\./i);
  });
});
