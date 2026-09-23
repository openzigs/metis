/**
 * Shared source-scanning primitive for the enumeration gates.
 *
 * Extracted from `redaction-sinks.enumeration.test.ts` (#85) once a SECOND
 * scanner was found without it: `docs-gen-warning-detail.enumeration.test.ts`
 * read raw source, so a doc comment that merely NAMED the pre-#67
 * `sectionFailedWarning(label, String(err))` shape was reported as a call site
 * that passes an exception. A gate that cannot tell prose from code makes
 * documenting the defect it guards against impossible — which is how a correct
 * change gets reworded to appease a test.
 *
 * Not a `.test.ts` file on purpose: the server suite's include pattern matches
 * test files only, so importing this from two of them does not re-run either
 * one's suites.
 */

/**
 * Blank every comment, replacing its characters with spaces so byte offsets and
 * line numbers are preserved exactly.
 *
 * This is load-bearing twice over. A *discussion* of `/token/i` — which several
 * modules carry, correctly — must not be mistaken for a declaration of one. And
 * an apostrophe in prose (`the UI's`) opens a phantom string for the balanced
 * slicer below, which then runs to end-of-file and attributes every key in the
 * rest of the module to one call. That is not hypothetical: it is what the
 * first draft of this scan did to `analysis/orchestrator.ts:1703`.
 */
export function blankComments(src: string): string {
  const out = src.split("");
  let i = 0;
  let prevSignificant = "";
  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < out.length; j++) if (out[j] !== "\n") out[j] = " ";
  };
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      let j = i;
      while (j < src.length && src[j] !== "\n") j++;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const j = end === -1 ? src.length : end + 2;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === c) break;
        j++;
      }
      i = j + 1;
      prevSignificant = c;
      continue;
    }
    // A `/` here is a regex literal when the previous significant character
    // cannot end an expression — otherwise it is division.
    if (c === "/" && (prevSignificant === "" || "=(,:[!&|?{};+-*%~^<>".includes(prevSignificant))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === "\\") {
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        else if (src[j] === "\n") break;
        j++;
      }
      i = j + 1;
      prevSignificant = "/";
      continue;
    }
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out.join("");
}
