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

/** Every METIS block marker. A fresh pattern per call, so no shared `lastIndex`. */
function internalMarkerPattern(): RegExp {
  return /<!--\s*metis:[\w:-]+\s*-->/g;
}

/**
 * The text with METIS's internal markers removed. A marker alone on its line
 * leaves a blank line, never nothing: the marker line is what separates the
 * block's last list item from a paragraph typed after it, and dropping the line
 * would join the two. One written inline leaves the text around it as it was,
 * less trailing spaces.
 */
export function stripMetisMarkers(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const stripped = line.replace(internalMarkerPattern(), "");
      // `trimEnd`, not a `[ \t]+$` regex: that backtracks quadratically on a long
      // run of tabs in stored text (CodeQL js/polynomial-redos).
      return stripped === line ? line : stripped.trimEnd();
    })
    .join("\n");
}
