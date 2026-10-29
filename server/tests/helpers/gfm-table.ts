/**
 * #1542 — the cells of every GFM table in `markdown`, as a real renderer
 * (micromark with the GFM extensions) shows them: one string per cell, with
 * inline markup removed and HTML entities decoded. A cell split by an
 * unescaped `|` shows up here as an extra cell, not as a passing substring.
 */
import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

/** The text nodes of the renderer's own cell HTML (not a sanitiser: nothing here is rendered). */
function text(html: string): string {
  return html
    .split(/<[^>]*>/)
    .join("")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

/** Each row of each table in `markdown`, header rows included. */
export function tableRows(markdown: string): string[][] {
  const html = micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  return [...html.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(([, row]) =>
    [...row.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/g)].map(([, cell]) => text(cell)),
  );
}
