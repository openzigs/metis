/**
 * #1834 — the committed staleness patch sets (`server/scripts/eval-localization-staleness/`):
 * each held-out set is exactly what the rule generates from the committed rows,
 * and fits its corpus; the table corpus's set covers every requirement.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadImpactRecallFixture, resolveCorpusDir } from "../impact-recall/fixture.js";
import { loadLocalizationCorpus, type LocalizationCorpusName } from "./corpus.js";
import {
  generateStalenessPatchSet,
  loadStalenessPatchSets,
  patchSetsDigest,
  STALENESS_ISSUE,
  stalenessPatchProblems,
  stalenessPatchSetsFor,
} from "./staleness.js";
import { guardPatchTargets, TABLE_GUARD_CORPUS, toFixturePath } from "./table-guard-source.js";

const sets = await loadStalenessPatchSets();

describe("the committed staleness patch sets (#1834)", () => {
  const heldOut: LocalizationCorpusName[] = [
    "localization-01-miniflux-heldout",
    "localization-02-fixture-portfolio",
  ];

  it.each(heldOut)("%s is what the rule generates, and fits the corpus", async (name) => {
    const corpus = await loadLocalizationCorpus(name);
    const set = sets.get(name);
    expect(set).toEqual(
      generateStalenessPatchSet({
        corpus: name,
        items: corpus.manifest.items,
        symbols: corpus.symbols,
      }),
    );
    expect(
      stalenessPatchProblems(set!, {
        name,
        itemIds: corpus.manifest.items.map((i) => i.id),
        symbols: corpus.symbols,
      }),
    ).toEqual([]);
    // Every item is patched, and never deletes one of its answer files.
    for (const item of corpus.manifest.items) {
      const ops = set!.items[item.id]!;
      expect(ops[0]!.op).toBe("edit");
      for (const op of ops.filter((o) => o.op === "delete")) {
        expect(item.expectedFiles).not.toContain(`${op.repo}:${op.op === "delete" ? op.file : ""}`);
      }
    }
  });

  it("the table corpus's set patches every requirement, on files the fixture maps", async () => {
    const fixture = await loadImpactRecallFixture(resolveCorpusDir(TABLE_GUARD_CORPUS));
    const set = sets.get(TABLE_GUARD_CORPUS)!;
    expect(set.issue).toBe(STALENESS_ISSUE);
    expect(Object.keys(set.items).sort()).toEqual(fixture.requirements.map((r) => r.id).sort());
    const targets = new Map(guardPatchTargets(fixture).map((t) => [t.id, t]));
    for (const [id, ops] of Object.entries(set.items)) {
      const edit = ops.find((o) => o.op === "edit");
      // The edit is in one of the requirement's answer files.
      expect(targets.get(id)!.expectedFiles).toContain(
        `jpetstore:${edit?.op === "edit" ? edit.file : ""}`,
      );
      for (const op of ops) {
        const file = op.op === "rename" ? op.from : op.file;
        expect(toFixturePath(file), `${id}: ${file}`).not.toBeNull();
      }
    }
  });

  it("digests the sets independently of their order", () => {
    const reversed = new Map([...sets.entries()].reverse());
    expect(patchSetsDigest(reversed)).toBe(patchSetsDigest(sets));
    expect(patchSetsDigest(new Map([...sets.entries()].slice(1)))).not.toBe(patchSetsDigest(sets));
  });

  it("#1933 — reads no patch directory when no arm applies a patch (A7R, A7RD alone)", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "patches-"));
    const missing = path.join(dir, "absent");
    try {
      expect((await stalenessPatchSetsFor(false, missing)).size).toBe(0);
      await expect(stalenessPatchSetsFor(true, missing)).rejects.toThrow(/ENOENT/);
      expect([...(await stalenessPatchSetsFor(true)).keys()]).toEqual([...sets.keys()]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a file named for another corpus", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "patches-"));
    try {
      await writeFile(
        path.join(dir, "a.json"),
        JSON.stringify({ corpus: "b", issue: STALENESS_ISSUE, rule: "r", items: {} }),
      );
      await expect(loadStalenessPatchSets(dir)).rejects.toThrow(/a.json holds the patch set of b/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
