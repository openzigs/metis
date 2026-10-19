/**
 * METIS writes HTML-comment markers into requirement bodies so a later pass can
 * find its own blocks: `<!-- metis:clarifications:start -->` / `:end -->`
 * around the clarification answers (#1116) and the inline
 * `<!-- metis:criteria-predate-answers -->` flag (#1000). They are bookkeeping,
 * never content, so every view and every document built from a body removes
 * them — the requirement card (#998), the baseline and review views (#1086) and
 * the requirements-scoped BRD (#1170), which used to escape them into visible
 * text instead.
 */

/**
 * Every METIS block marker, its name captured. A fresh pattern per call, so no
 * shared `lastIndex`. The one definition of what counts as a marker: hiding
 * them ({@link stripMetisMarkers}) and finding them ({@link findMetisMarkers})
 * must agree, or a whitespace variant hidden from view is invisible to the
 * pass that manages the block (#1162).
 */
function internalMarkerPattern(): RegExp {
  return /<!--\s*metis:([\w:-]+)\s*-->/g;
}

/** One METIS marker found in a text. */
export interface MetisMarker {
  /** The name after `metis:`, e.g. `clarifications:start`. */
  name: string;
  /** Offset of the marker's `<!--`. */
  index: number;
  /** Length of the whole marker as written. */
  length: number;
}

/** Every METIS marker in `text`, in order — whitespace variants included. */
export function findMetisMarkers(text: string): MetisMarker[] {
  return [...text.matchAll(internalMarkerPattern())].map((m) => ({
    name: m[1] ?? "",
    index: m.index ?? 0,
    length: m[0].length,
  }));
}

/**
 * The text with METIS's internal markers removed. A marker alone on its line
 * leaves a blank line, never nothing: the marker line is what separates the
 * block's last list item from a paragraph typed after it, and dropping the line
 * would join the two. One written inline leaves the text around it as it was,
 * less trailing spaces.
 *
 * #1237 — the markers removed are exactly the ones {@link findMetisMarkers}
 * finds, including one split across lines (the pattern's whitespace spans
 * newlines). Text typed after such a marker's `-->` starts a paragraph of its
 * own rather than joining the line the marker started on, which may be one of
 * METIS's quoted lines.
 */
export function stripMetisMarkers(text: string): string {
  const markers = findMetisMarkers(text);
  if (markers.length === 0) return text;
  let out = "";
  let from = 0;
  let line = 0;
  // Output lines a marker was removed from: only those are trimmed.
  const touched = new Set<number>();
  for (const m of markers) {
    const kept = text.slice(from, m.index);
    out += kept;
    line += kept.split("\n").length - 1;
    touched.add(line);
    from = m.index + m.length;
    if (!text.slice(m.index, from).includes("\n")) continue;
    // A split marker: anything after it on its last line becomes a paragraph.
    const lineEnd = text.indexOf("\n", from);
    const rest = text.slice(from, lineEnd === -1 ? text.length : lineEnd);
    if (rest.trim() === "") continue;
    out += "\n\n";
    line += 2;
    from += rest.length - rest.trimStart().length;
  }
  out += text.slice(from);
  // `trimEnd`, not a `[ \t]+$` regex: that backtracks quadratically on a long
  // run of tabs in stored text (CodeQL js/polynomial-redos).
  return out
    .split("\n")
    .map((l, i) => (touched.has(i) ? l.trimEnd() : l))
    .join("\n");
}
