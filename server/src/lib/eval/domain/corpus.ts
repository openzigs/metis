/**
 * Epic #803 (Epic 09) — Golden corpus loader.
 *
 * The corpus lives in `eval-data/corpus/<id>/` with two files per item:
 *   - `source.md`   the input document (PRD / BRD / user story)
 *   - `expected.json` an array of golden {@link DomainRequirement}
 *
 * Items are **auto-discovered** by scanning the corpus directory, so a
 * developer adds a new item by dropping in a folder + JSON with no code change
 * (Epic AC #3). `eval-data/manifest.json` is optional metadata (title, docType,
 * licence); a folder missing from the manifest still loads with safe defaults.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  domainManifestSchema,
  domainRequirementSchema,
  type DomainCorpusItemMeta,
  type DomainDocType,
  type DomainRequirement,
} from "@metis/shared";

export interface DomainCorpusItem {
  id: string;
  title: string;
  docType: DomainDocType;
  source: string;
  license: string;
  /** Raw document text fed to the extractor. */
  document: string;
  expected: DomainRequirement[];
}

export interface LoadCorpusOptions {
  /** Root `eval-data` directory. Defaults to `<cwd>/eval-data`. */
  dir?: string;
  /** Test seam — bypass the filesystem entirely. */
  inMemory?: DomainCorpusItem[];
}

const expectedArraySchema = z.array(domainRequirementSchema).min(1);
const SOURCE_FILES = ["source.md", "source.txt", "source.markdown"] as const;

export function defaultCorpusDir(cwd: string = process.cwd()): string {
  return path.resolve(cwd, "eval-data");
}

async function readManifest(dir: string): Promise<Map<string, DomainCorpusItemMeta>> {
  const map = new Map<string, DomainCorpusItemMeta>();
  try {
    const raw = await fs.readFile(path.join(dir, "manifest.json"), "utf8");
    const parsed = domainManifestSchema.parse(JSON.parse(raw));
    for (const item of parsed.items) map.set(item.id, item);
  } catch {
    // Manifest is optional — auto-discovery still works without it.
  }
  return map;
}

async function readSource(itemDir: string): Promise<string | null> {
  for (const name of SOURCE_FILES) {
    try {
      const raw = await fs.readFile(path.join(itemDir, name), "utf8");
      if (raw.trim().length > 0) return raw;
    } catch {
      // try next candidate filename
    }
  }
  return null;
}

function inferDocType(id: string, meta?: DomainCorpusItemMeta): DomainDocType {
  if (meta) return meta.docType;
  const lower = id.toLowerCase();
  if (lower.includes("brd")) return "brd";
  if (lower.includes("story") || lower.includes("us-")) return "user-story";
  return "prd";
}

/**
 * Load and validate every corpus item. Throws when an item's `expected.json`
 * is malformed (fail fast in CI) but silently skips folders that have no
 * source/expected pair so scratch directories don't break the run.
 */
export async function loadCorpus(opts: LoadCorpusOptions = {}): Promise<DomainCorpusItem[]> {
  if (opts.inMemory) return [...opts.inMemory].sort((a, b) => a.id.localeCompare(b.id));

  const root = opts.dir ?? defaultCorpusDir();
  const corpusDir = path.join(root, "corpus");
  const manifest = await readManifest(root);

  let entries: string[];
  try {
    const dirents = await fs.readdir(corpusDir, { withFileTypes: true });
    entries = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    throw new Error(
      `Domain eval corpus directory not found at ${corpusDir}: ${(err as Error).message}`,
    );
  }

  const items: DomainCorpusItem[] = [];
  for (const id of entries.sort((a, b) => a.localeCompare(b))) {
    const itemDir = path.join(corpusDir, id);
    const document = await readSource(itemDir);
    let expectedRaw: string;
    try {
      expectedRaw = await fs.readFile(path.join(itemDir, "expected.json"), "utf8");
    } catch {
      // Not a corpus item (no expected.json) — skip.
      continue;
    }
    if (document == null) {
      // Has expected.json but no source — surface it as a hard error.
      throw new Error(`Corpus item '${id}' has expected.json but no source.md`);
    }
    let expected: DomainRequirement[];
    try {
      expected = expectedArraySchema.parse(JSON.parse(expectedRaw));
    } catch (err) {
      throw new Error(`Corpus item '${id}' has invalid expected.json: ${(err as Error).message}`);
    }
    const meta = manifest.get(id);
    items.push({
      id,
      title: meta?.title ?? id,
      docType: inferDocType(id, meta),
      source: meta?.source ?? "original-synthetic",
      license: meta?.license ?? "CC0-1.0",
      document,
      expected,
    });
  }

  if (items.length === 0) {
    throw new Error(`Domain eval corpus at ${corpusDir} contains no valid items`);
  }
  return items;
}
