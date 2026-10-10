/**
 * Label sync — Phase 9 (#67).
 */
import { describe, expect, it } from "vitest";
import {
  combineLabels,
  DEFAULT_PUBLISH_LABELS,
  labelsToSync,
  publishableLabels,
  syncLabels,
} from "../src/lib/publishing/label-sync.js";
import type {
  OctokitRequestArgs,
  OctokitResponseLike,
  PublishOctokitLike,
} from "../src/lib/publishing/types.js";

function client(
  impl: (args: OctokitRequestArgs) => Promise<OctokitResponseLike>,
): PublishOctokitLike {
  // `request<T>` is caller-typed, as on the real client: `T` is what the caller
  // asserts the body holds, so a fake can only hand back `unknown` data.
  return { request: impl as PublishOctokitLike["request"] };
}

describe("syncLabels", () => {
  it("PUTs every unique label once", async () => {
    const calls: Array<{ method?: string; url?: string }> = [];
    const c = client(async (args) => {
      calls.push({ method: args.method, url: args.url });
      return { status: 200, headers: {}, data: {} };
    });
    const result = await syncLabels(c, { owner: "acme", repo: "metis" }, DEFAULT_PUBLISH_LABELS);
    expect(result.upserted).toBe(DEFAULT_PUBLISH_LABELS.length);
    expect(result.failed).toBe(0);
    expect(calls.every((c) => c.method === "PUT")).toBe(true);
  });

  it("falls back to POST on 404 from PUT", async () => {
    let putCalls = 0;
    let postCalls = 0;
    const c = client(async (args) => {
      if (args.method === "PUT") {
        putCalls += 1;
        const e = new Error("not found") as { status?: number };
        e.status = 404;
        throw e;
      }
      postCalls += 1;
      return { status: 201, headers: {}, data: {} };
    });
    const result = await syncLabels(c, { owner: "acme", repo: "metis" }, [
      { name: "feature", color: "0E8A16" },
    ]);
    expect(putCalls).toBe(1);
    expect(postCalls).toBe(1);
    expect(result.upserted).toBe(1);
  });

  it("collects errors when both PUT and POST fail", async () => {
    const c = client(async (args) => {
      if (args.method === "PUT") {
        const e = new Error("not found") as { status?: number };
        e.status = 404;
        throw e;
      }
      throw new Error("explosion");
    });
    const result = await syncLabels(c, { owner: "acme", repo: "metis" }, [
      { name: "epic", color: "3E4B9E" },
    ]);
    expect(result.upserted).toBe(0);
    expect(result.failed).toBe(1);
    expect(result.errors[0].message).toContain("explosion");
  });

  it("ignores duplicate label names case-insensitively", async () => {
    let calls = 0;
    const c = client(async () => {
      calls += 1;
      return { status: 200, headers: {}, data: {} };
    });
    await syncLabels(c, { owner: "acme", repo: "metis" }, [
      { name: "Feature", color: "x" },
      { name: "feature", color: "y" },
      { name: "FEATURE", color: "z" },
    ]);
    expect(calls).toBe(1);
  });
});

describe("combineLabels", () => {
  it("appends extras and dedupes case-insensitively", () => {
    const out = combineLabels(DEFAULT_PUBLISH_LABELS, ["custom-tag", "feature", "Custom-tag"]);
    const names = out.map((l) => l.name);
    expect(names).toContain("custom-tag");
    expect(names.filter((n) => n.toLowerCase() === "custom-tag").length).toBe(1);
    expect(names.filter((n) => n.toLowerCase() === "feature").length).toBe(1);
  });
});

describe("publishableLabels (#744)", () => {
  it("drops hidden finding:/review: labels, blanks and case-insensitive duplicates", () => {
    expect(
      publishableLabels([
        "feature",
        "finding:cmv1tix0d0vyu7d9kr8tbqrgq",
        "review:rejected",
        "  ",
        " Auth ",
        "auth",
      ]),
    ).toEqual(["feature", "Auth"]);
  });
});

describe("labelsToSync (#744)", () => {
  it("upserts only labels a draft carries, keeping base colours, plus requested extras", () => {
    const out = labelsToSync(
      [
        ["feature", "metis-generated", "priority:high", "finding:abc"],
        ["Feature", "feeds"],
      ],
      ["release-1", "finding:xyz"],
    );
    expect(out.map((l) => l.name)).toEqual([
      "feature",
      "metis-generated",
      "priority:high",
      "feeds",
      "release-1",
    ]);
    const base = new Map(DEFAULT_PUBLISH_LABELS.map((l) => [l.name, l]));
    expect(out[0]).toEqual(base.get("feature"));
    expect(out.find((l) => l.name === "feeds")?.color).toBe("ededed");
  });

  it("upserts nothing for a batch with no labels at all", () => {
    expect(labelsToSync([[], []], [])).toEqual([]);
  });
});
