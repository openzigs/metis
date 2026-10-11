/**
 * #1034 — which Go callee names a bound call may be followed through. The names
 * are the ones measured on the Miniflux v2.3.3 graph (PR #1086).
 */
import { describe, expect, it } from "vitest";
import {
  COMMON_GO_COMPOUND_CALLEES,
  goNameWords,
  isDistinctiveGoCallee,
  isExportedGoName,
} from "./go-inferred-call-names.js";

describe("goNameWords", () => {
  it.each([
    ["SetEntriesStatus", ["Set", "Entries", "Status"]],
    ["parseLines", ["parse", "Lines"]],
    ["RootURL", ["Root", "URL"]],
    ["HTTPClientTimeout", ["HTTP", "Client", "Timeout"]],
    ["OAuth2State", ["O", "Auth2", "State"]],
    ["snake_case_name", ["snake", "case", "name"]],
    ["HTTPS", ["HTTPS"]],
    ["Printf", ["Printf"]],
    ["Close", ["Close"]],
  ])("%s", (name, words) => {
    expect(goNameWords(name)).toEqual(words);
  });
});

describe("isDistinctiveGoCallee", () => {
  it.each(["Close", "New", "Run", "Error", "String", "Write", "Read", "Get", "Now", "Do", "HTTPS"])(
    "refuses the one-word name %s",
    (name) => {
      expect(isDistinctiveGoCallee(name)).toBe(false);
    },
  );

  it.each(["WithTimeout", "NewRequest", "ReadAll", "ServeHTTP", "MarshalJSON", "QueryRow"])(
    "refuses the well-known compound stdlib name %s",
    (name) => {
      expect(COMMON_GO_COMPOUND_CALLEES.has(name)).toBe(true);
      expect(isDistinctiveGoCallee(name)).toBe(false);
    },
  );

  it.each([
    "SetEntriesStatus",
    "CreateBookmark",
    "parseLines",
    "NewClientWithOptions",
    "IsOAuth2UserCreationAllowed",
    "WithLastModified",
  ])("accepts the project's own compound name %s", (name) => {
    expect(isDistinctiveGoCallee(name)).toBe(true);
  });
});

describe("isExportedGoName", () => {
  it("follows Go's capitalisation rule", () => {
    expect(isExportedGoName("ParseFile")).toBe(true);
    expect(isExportedGoName("parseLines")).toBe(false);
    expect(isExportedGoName("_private")).toBe(false);
  });
});
