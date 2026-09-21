/**
 * `isJunkSourcePath` — OS/archive metadata-junk predicate.
 *
 * Proves the macOS AppleDouble / resource-fork filter that keeps `__MACOSX/`
 * stubs out of ingestion, traversal, and grounding retrieval. The `risk` SAS
 * upload had 91/182 "files" be `__MACOSX/.../._*.sas` stubs; this predicate is
 * the single shared gate that drops them everywhere.
 */
import { describe, expect, it } from "vitest";
import { isJunkSourcePath } from "../src/index.js";

describe("isJunkSourcePath — junk (returns true)", () => {
  it("flags an AppleDouble stub inside a __MACOSX tree", () => {
    expect(isJunkSourcePath("__MACOSX/RISK_CALC_SAS/src/._Foo.sas")).toBe(true);
  });

  it("flags any path with a __MACOSX segment regardless of basename", () => {
    expect(isJunkSourcePath("__MACOSX/foo.sas")).toBe(true);
    expect(isJunkSourcePath("a/b/__MACOSX/c/real_name.sas")).toBe(true);
  });

  it("flags a bare AppleDouble basename outside __MACOSX", () => {
    expect(isJunkSourcePath("RISK_CALC_SAS/src/._Foo.sas")).toBe(true);
    expect(isJunkSourcePath("._Foo.sas")).toBe(true);
  });

  it("flags desktop-metadata files", () => {
    expect(isJunkSourcePath("project/.DS_Store")).toBe(true);
    expect(isJunkSourcePath(".DS_Store")).toBe(true);
    expect(isJunkSourcePath("project/Thumbs.db")).toBe(true);
  });

  it("recognises Windows-separator paths too", () => {
    expect(isJunkSourcePath("__MACOSX\\RISK_CALC_SAS\\src\\._Foo.sas")).toBe(true);
    expect(isJunkSourcePath("a\\b\\._Foo.sas")).toBe(true);
  });

  it("flags junk embedded in a connector-prefixed RAG filename", () => {
    // grounding-retrieval filters on the chunk filename, which carries the
    // connector prefix + the original relative path.
    expect(isJunkSourcePath("connector:repo:abc123:src/__MACOSX/x/._Foo.sas")).toBe(true);
    expect(isJunkSourcePath("connector:repo:abc123:src/RISK_CALC_SAS/._Foo.sas")).toBe(true);
  });
});

describe("isJunkSourcePath — real source (returns false)", () => {
  it("does NOT flag a genuine SAS source file", () => {
    expect(isJunkSourcePath("RISK_CALC_SAS/src/Foo.sas")).toBe(false);
  });

  it("does NOT flag other genuine source files", () => {
    expect(isJunkSourcePath("src/index.ts")).toBe(false);
    expect(isJunkSourcePath("a/b/c/main.py")).toBe(false);
    expect(isJunkSourcePath("Foo.sas")).toBe(false);
  });

  it("does NOT flag a connector-prefixed real source filename", () => {
    expect(isJunkSourcePath("connector:repo:abc123:src/RISK_CALC_SAS/src/Foo.sas")).toBe(false);
  });

  it("does NOT flag a directory literally named with a leading dot but not AppleDouble", () => {
    // `.github`, `.config` etc. are dot-dirs, not `._` AppleDouble stubs.
    expect(isJunkSourcePath(".github/workflows/ci.yml")).toBe(false);
    expect(isJunkSourcePath("a/.config/app.ts")).toBe(false);
  });

  it("does NOT flag `..` traversal segments (handled elsewhere) as AppleDouble", () => {
    // `..` starts with a dot but not `._`; junk filtering must not claim it.
    expect(isJunkSourcePath("a/../b/Foo.sas")).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(isJunkSourcePath("")).toBe(false);
  });
});
