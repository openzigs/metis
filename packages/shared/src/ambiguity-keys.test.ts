import { describe, expect, it } from "vitest";
import { ambiguityFieldKeys, ambiguityKeys, openAmbiguityCount } from "./ambiguity-keys.js";

const amb = (field: string) => ({ field });

describe("ambiguityFieldKeys (#2451)", () => {
  it("keeps a field that is unique in its requirement as it is", () => {
    expect(ambiguityFieldKeys([amb("scope"), amb("R7:fast")])).toEqual(["scope", "R7:fast"]);
  });

  it("numbers the second and later ambiguities on the same field", () => {
    // The live run: every ambiguity of a requirement was on `description`.
    expect(
      ambiguityFieldKeys([
        amb("description"),
        amb("description"),
        amb("scope"),
        amb("description"),
      ]),
    ).toEqual(["description", "description#2", "scope", "description#3"]);
  });

  it("never gives two ambiguities one key, even past a field already named like one", () => {
    expect(ambiguityFieldKeys([amb("a"), amb("a#2"), amb("a")])).toEqual(["a", "a#2", "a#3"]);
    const keys = ambiguityFieldKeys([amb("a"), amb("a"), amb("a#2")]);
    expect(new Set(keys).size).toBe(3);
  });

  it("is empty for no ambiguities", () => {
    expect(ambiguityFieldKeys([])).toEqual([]);
  });
});

describe("ambiguityKeys (#2451)", () => {
  it("prefixes each field key with the requirement id", () => {
    expect(
      ambiguityKeys({ id: "r1", ambiguities: [amb("description"), amb("description")] }),
    ).toEqual(["r1:description", "r1:description#2"]);
  });

  it("reads a requirement stored without an ambiguities array (#403) as having none", () => {
    expect(ambiguityKeys({ id: "r1" })).toEqual([]);
    expect(ambiguityKeys({ id: "r1", ambiguities: null })).toEqual([]);
  });
});

describe("openAmbiguityCount (#2451)", () => {
  const requirements = [
    { id: "r1", ambiguities: [amb("description"), amb("description"), amb("description")] },
    { id: "r2", ambiguities: [amb("scope")] },
    { id: "r3" },
  ];

  it("counts every ambiguity when nothing is addressed", () => {
    expect(openAmbiguityCount(requirements, new Set())).toBe(4);
  });

  it("falls by one per answered ambiguity, not per field", () => {
    // Answering one of three `description` ambiguities closes that one only.
    expect(openAmbiguityCount(requirements, new Set(["r1:description"]))).toBe(3);
    expect(openAmbiguityCount(requirements, new Set(["r1:description#2", "r2:scope"]))).toBe(2);
  });

  it("ignores keys that name no ambiguity", () => {
    expect(openAmbiguityCount(requirements, new Set(["r1:delivery_mechanism", "zz:x"]))).toBe(4);
  });
});
