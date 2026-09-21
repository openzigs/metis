/**
 * #785 — the entry-point guard, and specifically its Windows behaviour.
 *
 * IMPORTANT, and the reason `isMainModule` takes a `toFileUrl` seam: `pathToFileURL`
 * is PLATFORM-DEPENDENT, and this suite runs on macOS/Linux. We therefore cannot
 * exercise the real win32 `pathToFileURL` here. What we CAN do — and what these
 * tests do — is:
 *
 *   1. verify the real (posix) behaviour end-to-end on this platform;
 *   2. verify the COMPARISON logic (the part this module owns) against win32-SHAPED
 *      hrefs, by injecting a converter that reproduces documented win32
 *      `pathToFileURL` output;
 *   3. pin the exact defects in the old `new URL("file://" + argv1)` idiom, so a
 *      regression to it fails here rather than on a Windows dev's machine.
 *
 * (2) is a genuine test of our logic and NOT a claim that this was run on Windows.
 */
import { describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import { isMainModule, normalizeFileUrl, type FileUrlConverter } from "./main-module.js";

/**
 * Reproduces win32 `pathToFileURL` output while running on POSIX: backslashes →
 * forward slashes, drive letter kept, and `%`, `#`, `?` percent-encoded (which is
 * precisely what the old idiom failed to do).
 */
const win32PathToFileURL: FileUrlConverter = (p: string) => {
  const encoded = p
    .replace(/\\/g, "/")
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F");
  return { href: `file:///${encoded}` };
};

/** The pre-#785 idiom, reproduced verbatim so we can assert it is broken. */
function legacyIsMain(importMetaUrl: string, argv1: string): boolean {
  return importMetaUrl === new URL(`file://${argv1}`).href;
}

describe("normalizeFileUrl", () => {
  it("uppercases a lowercase Windows drive letter", () => {
    expect(normalizeFileUrl("file:///c:/Users/dev/x.ts")).toBe("file:///C:/Users/dev/x.ts");
  });

  it("leaves an already-uppercase drive letter alone", () => {
    expect(normalizeFileUrl("file:///C:/Users/dev/x.ts")).toBe("file:///C:/Users/dev/x.ts");
  });

  it("normalizes a percent-encoded drive colon (%3a → %3A)", () => {
    expect(normalizeFileUrl("file:///c%3a/Users/dev/x.ts")).toBe("file:///C%3A/Users/dev/x.ts");
  });

  it("does NOT lowercase the rest of the path (percent-encoding is case-sensitive)", () => {
    expect(normalizeFileUrl("file:///C:/Src/Metis/My%20Dir/x.ts")).toBe(
      "file:///C:/Src/Metis/My%20Dir/x.ts",
    );
  });

  it("leaves a POSIX href untouched", () => {
    expect(normalizeFileUrl("file:///Users/dev/metis/x.ts")).toBe("file:///Users/dev/metis/x.ts");
  });
});

describe("isMainModule — POSIX (really executed on this platform)", () => {
  const entry = "/Users/dev/metis/server/scripts/prefetch-embeddings-model.ts";

  it("matches when argv[1] is the module's own path", () => {
    expect(isMainModule(pathToFileURL(entry).href, entry)).toBe(true);
  });

  it("does not match a different entry script", () => {
    expect(
      isMainModule(pathToFileURL(entry).href, "/Users/dev/metis/server/scripts/other.ts"),
    ).toBe(false);
  });

  it("returns false when there is no argv[1] (e.g. `node -e`)", () => {
    expect(isMainModule(pathToFileURL(entry).href, undefined)).toBe(false);
  });

  it("matches a path containing a space", () => {
    const spaced = "/Users/dev/My Projects/metis/x.ts";
    expect(isMainModule(pathToFileURL(spaced).href, spaced)).toBe(true);
  });

  it("returns false rather than throwing when the converter rejects the path", () => {
    const throwing: FileUrlConverter = () => {
      throw new Error("nope");
    };
    expect(isMainModule("file:///Users/dev/x.ts", "\0bad", throwing)).toBe(false);
  });
});

describe("isMainModule — Windows-SHAPED (comparison logic only; NOT run on Windows)", () => {
  const winEntry = "C:\\Users\\dev\\metis\\server\\scripts\\prefetch-embeddings-model.ts";
  const winHref = "file:///C:/Users/dev/metis/server/scripts/prefetch-embeddings-model.ts";

  it("matches a plain drive path", () => {
    expect(isMainModule(winHref, winEntry, win32PathToFileURL)).toBe(true);
  });

  it("matches when argv[1] carries a LOWERCASE drive letter", () => {
    const lower = "c:\\Users\\dev\\metis\\server\\scripts\\prefetch-embeddings-model.ts";
    expect(isMainModule(winHref, lower, win32PathToFileURL)).toBe(true);
  });

  it("matches a path containing '#' — which the legacy idiom silently failed", () => {
    const hashed = "C:\\proj#1\\metis\\prefetch.ts";
    const href = "file:///C:/proj%231/metis/prefetch.ts";
    expect(isMainModule(href, hashed, win32PathToFileURL)).toBe(true);

    // The bug being fixed: the old idiom parses "#1\metis\prefetch.ts" as a URL
    // FRAGMENT, so the guard is false and the script exits 0 doing nothing.
    expect(new URL(`file://${hashed}`).href).toBe("file:///C:/proj#1\\metis\\prefetch.ts");
    expect(legacyIsMain(href, hashed)).toBe(false);
  });

  it("matches a path containing '?' — also broken under the legacy idiom", () => {
    const q = "C:\\proj?x\\metis\\prefetch.ts";
    const href = "file:///C:/proj%3Fx/metis/prefetch.ts";
    expect(isMainModule(href, q, win32PathToFileURL)).toBe(true);
    expect(legacyIsMain(href, q)).toBe(false);
  });

  it("matches a path containing a literal '%' — also broken under the legacy idiom", () => {
    const pct = "C:\\pct%20dir\\prefetch.ts";
    const href = "file:///C:/pct%2520dir/prefetch.ts";
    expect(isMainModule(href, pct, win32PathToFileURL)).toBe(true);

    // The old idiom leaves "%20" decoded, so it compares against the wrong href.
    expect(new URL(`file://${pct}`).href).toBe("file:///C:/pct%20dir/prefetch.ts");
    expect(legacyIsMain(href, pct)).toBe(false);
  });

  it("still rejects a genuinely different Windows entry script", () => {
    expect(
      isMainModule(winHref, "C:\\Users\\dev\\metis\\server\\scripts\\other.ts", win32PathToFileURL),
    ).toBe(false);
  });
});
