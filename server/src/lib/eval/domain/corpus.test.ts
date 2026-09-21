/**
 * Epic #803 (Epic 09) — corpus loader unit tests.
 */
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DomainCorpusItem } from "./corpus.js";
import { defaultCorpusDir, loadCorpus } from "./corpus.js";

const tmpDirs: string[] = [];

async function makeCorpus(
  items: { id: string; source?: string | null; expected?: unknown; manifest?: unknown }[],
  opts: { withManifest?: unknown } = {},
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "domain-corpus-"));
  tmpDirs.push(root);
  await fs.mkdir(path.join(root, "corpus"), { recursive: true });
  for (const it of items) {
    const dir = path.join(root, "corpus", it.id);
    await fs.mkdir(dir, { recursive: true });
    if (it.source !== null) {
      await fs.writeFile(path.join(dir, "source.md"), it.source ?? `- The system must ${it.id}.`);
    }
    if (it.expected !== undefined) {
      await fs.writeFile(path.join(dir, "expected.json"), JSON.stringify(it.expected));
    }
  }
  if (opts.withManifest !== undefined) {
    await fs.writeFile(path.join(root, "manifest.json"), JSON.stringify(opts.withManifest));
  }
  return root;
}

const goldenReq = (id = "R1") => ({
  id,
  type: "feature",
  title: "Title",
  description: "a golden description",
  priority: "high",
});

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("defaultCorpusDir", () => {
  it("resolves <cwd>/eval-data", () => {
    expect(defaultCorpusDir("/repo")).toBe(path.resolve("/repo", "eval-data"));
  });
});

describe("loadCorpus", () => {
  it("returns sorted in-memory items without touching the filesystem", async () => {
    const inMemory: DomainCorpusItem[] = [
      {
        id: "b",
        title: "B",
        docType: "prd",
        source: "s",
        license: "l",
        document: "d",
        expected: [goldenReq()],
      },
      {
        id: "a",
        title: "A",
        docType: "brd",
        source: "s",
        license: "l",
        document: "d",
        expected: [goldenReq()],
      },
    ];
    const out = await loadCorpus({ inMemory });
    expect(out.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("auto-discovers items and infers docType from the id", async () => {
    const dir = await makeCorpus([
      { id: "brd-x", expected: [goldenReq()] },
      { id: "us-y", expected: [goldenReq()] },
      { id: "prd-z", expected: [goldenReq()] },
    ]);
    const out = await loadCorpus({ dir });
    const byId = Object.fromEntries(out.map((i) => [i.id, i]));
    expect(byId["brd-x"].docType).toBe("brd");
    expect(byId["us-y"].docType).toBe("user-story");
    expect(byId["prd-z"].docType).toBe("prd");
  });

  it("applies manifest metadata when present", async () => {
    const dir = await makeCorpus([{ id: "item-1", expected: [goldenReq()] }], {
      withManifest: {
        version: 1,
        items: [
          {
            id: "item-1",
            title: "Nice Title",
            docType: "user-story",
            source: "synthetic",
            license: "MIT",
          },
        ],
      },
    });
    const [it] = await loadCorpus({ dir });
    expect(it.title).toBe("Nice Title");
    expect(it.docType).toBe("user-story");
    expect(it.license).toBe("MIT");
  });

  it("skips folders that have no expected.json", async () => {
    const dir = await makeCorpus([
      { id: "real", expected: [goldenReq()] },
      { id: "scratch", source: "- noise", expected: undefined },
    ]);
    const out = await loadCorpus({ dir });
    expect(out.map((i) => i.id)).toEqual(["real"]);
  });

  it("throws when an item has expected.json but no source", async () => {
    const dir = await makeCorpus([{ id: "broken", source: null, expected: [goldenReq()] }]);
    await expect(loadCorpus({ dir })).rejects.toThrow(/no source/i);
  });

  it("throws on malformed expected.json", async () => {
    const dir = await makeCorpus([{ id: "bad", expected: [{ id: "R1" }] }]);
    await expect(loadCorpus({ dir })).rejects.toThrow(/invalid expected\.json/i);
  });

  it("throws when the corpus directory is missing", async () => {
    await expect(loadCorpus({ dir: "/no/such/eval-data" })).rejects.toThrow(/not found/i);
  });

  it("throws when no valid items exist", async () => {
    const dir = await makeCorpus([{ id: "empty", source: "- x", expected: undefined }]);
    await expect(loadCorpus({ dir })).rejects.toThrow(/no valid items/i);
  });
});
