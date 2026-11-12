/** #2241 — chat's relevance floor on automatic retrieval. */
import { afterEach, describe, expect, it } from "vitest";
import { __resetConfigSingleton } from "../config/config-service.js";
import {
  applyRelevanceFloor,
  CHAT_RELEVANCE_FLOOR_KEY,
  DEFAULT_CHAT_RELEVANCE_FLOOR,
  denseCosine,
  readRelevanceFloor,
} from "./relevance-floor.js";

type Hit = { id: string; score: number; denseScore?: number; matchedBy?: ("dense" | "lexical")[] };

const dense = (id: string, score: number): Hit => ({ id, score, matchedBy: ["dense"] });
const lexical = (id: string): Hit => ({ id, score: 0, matchedBy: ["lexical"] });

describe("denseCosine", () => {
  it("reads denseScore before score, so a reranker's logit is never read as a cosine", () => {
    expect(denseCosine({ score: -11.4, denseScore: 0.71, matchedBy: ["dense", "lexical"] })).toBe(
      0.71,
    );
    expect(denseCosine({ score: 0.64, matchedBy: ["dense"] })).toBe(0.64);
  });

  it("has no cosine for a hit only the keyword search found", () => {
    expect(denseCosine({ score: 0, matchedBy: ["lexical"] })).toBeNull();
  });

  it("reads score when the hit does not say which retriever found it", () => {
    expect(denseCosine({ score: 0.6 })).toBe(0.6);
  });
});

describe("applyRelevanceFloor", () => {
  it("drops the hits below the floor, keeps the rest in order, and counts the dropped", () => {
    const hits = [dense("a", 0.8), dense("b", 0.5), dense("c", 0.56), dense("d", 0.55)];
    const { kept, belowFloor } = applyRelevanceFloor(hits, 0.55);
    expect(kept.map((h) => h.id)).toEqual(["a", "c", "d"]);
    expect(belowFloor).toBe(1);
  });

  it("keeps a keyword-only hit beside a dense hit that cleared the floor", () => {
    const { kept } = applyRelevanceFloor([dense("a", 0.7), lexical("k")], 0.55);
    expect(kept.map((h) => h.id)).toEqual(["a", "k"]);
  });

  it("drops a keyword-only hit when no dense hit cleared the floor", () => {
    const { kept, belowFloor } = applyRelevanceFloor([dense("a", 0.4), lexical("k")], 0.55);
    expect(kept).toEqual([]);
    expect(belowFloor).toBe(2);
  });

  it("floors a reranked hit on its cosine, not its rewritten score", () => {
    const reranked: Hit = { id: "r", score: 4.2, denseScore: 0.3, matchedBy: ["dense"] };
    expect(applyRelevanceFloor([reranked], 0.55).kept).toEqual([]);
  });

  it("keeps every hit when the floor is 0", () => {
    const hits = [dense("a", 0.1), lexical("k")];
    expect(applyRelevanceFloor(hits, 0)).toEqual({ kept: hits, belowFloor: 0 });
  });
});

describe("readRelevanceFloor", () => {
  afterEach(() => {
    delete process.env[CHAT_RELEVANCE_FLOOR_KEY];
    __resetConfigSingleton();
  });

  const GTE = "Alibaba-NLP/gte-modernbert-base";
  const read = (value?: string, models: string[] = [GTE]) => {
    if (value === undefined) delete process.env[CHAT_RELEVANCE_FLOOR_KEY];
    else process.env[CHAT_RELEVANCE_FLOOR_KEY] = value;
    __resetConfigSingleton();
    return readRelevanceFloor(models);
  };

  it("is the calibrated default when unset or blank", () => {
    expect(read()).toBe(DEFAULT_CHAT_RELEVANCE_FLOOR);
    expect(read("  ")).toBe(DEFAULT_CHAT_RELEVANCE_FLOOR);
  });

  it("reads a decimal (not an integer: 0.4 is not 0)", () => {
    expect(read("0.4")).toBe(0.4);
  });

  it("turns off at 0, and falls back to the default on a value that is not a number", () => {
    expect(read("0")).toBe(0);
    expect(read("abc")).toBe(DEFAULT_CHAT_RELEVANCE_FLOOR);
  });

  it("is off for an uncalibrated embedder unless the operator set the key", () => {
    expect(read(undefined, ["text-embedding-3-small"])).toBe(0);
    expect(read(undefined, [GTE, "hash-stub"])).toBe(0);
    expect(read(undefined, [])).toBe(0);
    expect(read("0.3", ["text-embedding-3-small"])).toBe(0.3);
  });

  it("holds the value to 0..1", () => {
    expect(read("2")).toBe(1);
    expect(read("-1")).toBe(0);
  });
});
