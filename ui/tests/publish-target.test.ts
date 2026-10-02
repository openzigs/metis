/** #733 — publish-target helpers. */
import { describe, expect, it } from "vitest";
import {
  commonDraftTarget,
  draftTargetsConflict,
  isAnalysedRepo,
  sameTarget,
} from "@/lib/publish-target";

const m = (o: unknown, r: unknown) => JSON.stringify({ targetOwner: o, targetRepo: r });

describe("commonDraftTarget", () => {
  it("is null for no drafts", () => {
    expect(commonDraftTarget([])).toBeNull();
  });

  it("returns the one target every draft shares (case-insensitively)", () => {
    expect(
      commonDraftTarget([
        { metadata: m("OpenZigs", "flux-v2") },
        { metadata: m("openzigs", "FLUX-V2") },
      ]),
    ).toEqual({
      owner: "OpenZigs",
      repo: "flux-v2",
    });
  });

  it("is null when the drafts disagree", () => {
    expect(commonDraftTarget([{ metadata: m("a", "b") }, { metadata: m("a", "c") }])).toBeNull();
  });

  it.each([
    [null],
    [undefined],
    ["{not json"],
    [JSON.stringify({ analysisId: "x" })],
    [m("", "repo")],
    [m("owner", 3)],
  ])("is null when any draft records no usable target (%s)", (metadata) => {
    expect(commonDraftTarget([{ metadata: m("a", "b") }, { metadata }])).toBeNull();
  });
});

describe("draftTargetsConflict", () => {
  it("is false for no drafts, one shared target, or only legacy drafts", () => {
    expect(draftTargetsConflict([])).toBe(false);
    expect(draftTargetsConflict([{ metadata: m("a", "b") }, { metadata: m("A", "B") }])).toBe(
      false,
    );
    expect(draftTargetsConflict([{ metadata: null }, { metadata: undefined }])).toBe(false);
  });

  it("is true when the drafts record different targets", () => {
    expect(draftTargetsConflict([{ metadata: m("a", "b") }, { metadata: m("a", "c") }])).toBe(true);
  });

  it("is true when a recorded target is mixed with a draft that records none", () => {
    expect(draftTargetsConflict([{ metadata: m("a", "b") }, { metadata: null }])).toBe(true);
  });
});

describe("sameTarget", () => {
  it("compares owner and repo case-insensitively", () => {
    expect(sameTarget({ owner: "A", repo: "B" }, { owner: "a", repo: "b" })).toBe(true);
    expect(sameTarget({ owner: "a", repo: "b" }, { owner: "a", repo: "c" })).toBe(false);
    expect(sameTarget({ owner: "a", repo: "b" }, { owner: "x", repo: "b" })).toBe(false);
  });
});

describe("isAnalysedRepo", () => {
  const conn = { ownerOrOrg: "miniflux", repoName: "v2" };
  it("is true for the connector's own repository", () => {
    expect(isAnalysedRepo({ owner: "Miniflux", repo: "V2" }, conn)).toBe(true);
  });
  it("is false for another repository", () => {
    expect(isAnalysedRepo({ owner: "openzigs", repo: "v2" }, conn)).toBe(false);
  });
  it("is false with no connector, or a local connector with no owner/repo", () => {
    expect(isAnalysedRepo({ owner: "miniflux", repo: "v2" }, null)).toBe(false);
    expect(
      isAnalysedRepo({ owner: "miniflux", repo: "v2" }, { ownerOrOrg: null, repoName: "v2" }),
    ).toBe(false);
  });
  it("is false for an incomplete target", () => {
    expect(isAnalysedRepo({ owner: "", repo: "" }, { ownerOrOrg: "", repoName: "" })).toBe(false);
    expect(isAnalysedRepo({ owner: "miniflux", repo: "" }, conn)).toBe(false);
  });
});
