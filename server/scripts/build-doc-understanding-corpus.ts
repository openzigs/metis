/**
 * #2229 — `pnpm --filter server eval:doc-understanding:build`: rebuild each
 * document-understanding corpus item's `source.docx` and `labels.json` from
 * its authored `frd.src.md`, then check the labels against the rebuilt Word
 * document. Run it after editing a source; commit all three files.
 *
 *   pnpm --filter server eval:doc-understanding:build
 *   pnpm --filter server eval:doc-understanding:build --check   # labels.json up to date? (writes nothing)
 */
/* eslint-disable no-console -- a CLI whose output is its report */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseFrdSource } from "../src/lib/eval/doc-understanding/corpus-source.js";
import {
  DOC_UNDERSTANDING_CORPORA,
  LABEL_STATUS,
  corpusRoot,
  loadDocUnderstandingItem,
  sha256,
} from "../src/lib/eval/doc-understanding/corpus.js";
import { renderFrdDocx } from "../src/lib/eval/doc-understanding/docx-render.js";

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const name of DOC_UNDERSTANDING_CORPORA) {
    const dir = path.join(corpusRoot(), name);
    const source = await readFile(path.join(dir, "frd.src.md"), "utf8");
    const parsed = parseFrdSource(source);
    const labels = {
      corpusId: name,
      title: parsed.title,
      license: "CC0-1.0",
      labelStatus: LABEL_STATUS,
      sourceSha256: sha256(source),
      ...parsed.labels,
    };
    const json = `${JSON.stringify(labels, null, 2)}\n`;
    const labelsPath = path.join(dir, "labels.json");
    if (check) {
      const held = await readFile(labelsPath, "utf8").catch(() => "");
      if (held !== json) {
        stale++;
        console.log(`${name}: labels.json is stale; run without --check`);
      }
      continue;
    }
    await writeFile(
      path.join(dir, "source.docx"),
      await renderFrdDocx(parsed.title, parsed.blocks),
    );
    await writeFile(labelsPath, json, "utf8");
    const item = await loadDocUnderstandingItem(name);
    console.log(
      `${name}: ${item.docxBytes} bytes of Word, ${item.text.length} characters converted, ` +
        `${item.sections.length} sections, ${labels.requirements.length} requirements, ` +
        `${labels.ambiguities.length} ambiguities`,
    );
  }
  if (stale > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
