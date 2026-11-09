/**
 * #1977 — `ConfigService.getBool` and the governing-documents flag share ONE
 * truthy test, so a spelling added to it reaches both. The governing flag once
 * carried a hand copy of `getBool`'s pattern, which would have diverged the
 * moment either changed.
 *
 * `./truthy.js` is wrapped so a case can swap its implementation: a reader that
 * kept its own pattern would not follow the swap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  override: null as ((raw: string) => boolean) | null,
}));

vi.mock("./truthy.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./truthy.js")>();
  return {
    isTruthyConfigValue: (raw: string) =>
      state.override ? state.override(raw) : actual.isTruthyConfigValue(raw),
  };
});
vi.mock("../prisma.js", () => ({ prisma: {} }));

import { isGoverningDocsEnabled } from "../governing/flag.js";
import { ConfigService, isTruthyConfigValue } from "./config-service.js";
import type { VaultService } from "../vault/vault-service.js";

/** A registered `bool` key, read from the env when no tunable row is cached. */
const BOOL_KEY = "SCHEDULER_ENABLED";

function getBool(raw: string, defaultValue = false): boolean {
  const svc = new ConfigService({ vault: {} as VaultService, env: { [BOOL_KEY]: raw } });
  return svc.getBool(BOOL_KEY, defaultValue);
}

function flag(raw: string): boolean {
  return isGoverningDocsEnabled({ GOVERNING_DOCS_ENABLED: raw });
}

const SPELLINGS = [
  "1",
  "true",
  "TRUE",
  "True",
  "yes",
  "YES",
  "on",
  "On",
  " 1",
  "true ",
  "\ttrue\n",
  "0",
  "false",
  "no",
  "off",
  "",
  "  ",
  "enabled",
  "2",
  "truee",
  "1 0",
  "y",
  "t",
];

describe("isTruthyConfigValue (#1977)", () => {
  beforeEach(() => {
    state.override = null;
  });

  it.each(["1", "true", "TRUE", "yes", "on", "On", " yes ", "\ton\n"])("is true for %j", (raw) => {
    expect(isTruthyConfigValue(raw)).toBe(true);
  });

  it.each(["0", "false", "no", "off", "", " ", "enabled", "y", "truee", "1 0"])(
    "is false for %j",
    (raw) => {
      expect(isTruthyConfigValue(raw)).toBe(false);
    },
  );

  // #1878 — the flag defaults on, so its reference is `getBool(key, true)`, which
  // reads an empty value as unset (the default) and every other value through
  // the shared test.
  it.each(SPELLINGS)("getBool(key, true) and the governing flag agree on %j", (raw) => {
    expect(flag(raw)).toBe(getBool(raw, true));
    expect(flag(raw)).toBe(raw === "" ? true : isTruthyConfigValue(raw));
  });

  it("both readers follow a change to the shared test, so neither keeps its own copy", () => {
    // A spelling neither accepts today, accepted only by the swapped-in test.
    state.override = (raw) => raw === "affirmative";
    expect(getBool("affirmative")).toBe(true);
    expect(flag("affirmative")).toBe(true);
    expect(getBool("true")).toBe(false);
    expect(flag("true")).toBe(false);
  });
});
