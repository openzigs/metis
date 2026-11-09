/**
 * Issue #2109 (owner decision on #2108) — governing checks stay on by default,
 * but are marked **Preview** until the held-out real-policy set (governing-03,
 * #2105) passes its bars. Its first reading failed 3 of 5: recall 0.80,
 * non-resembling recall 0.50 and precision 0.52.
 *
 * The one place the mark is set: the workspace Governing documents tab and the
 * analysis view's Governing rules panel (`GoverningPreviewNotice` in the UI)
 * and the BRD's governing-rules section (`governingPreviewLines` on the server)
 * all read `GOVERNING_PREVIEW`. Set it to `false` here to remove the mark
 * everywhere.
 *
 * The note is held to the wording guard (#1875): it must never claim
 * compliance (`governing-preview.test.ts`).
 */

/** Whether governing checks are marked Preview wherever an analyst meets them. */
export const GOVERNING_PREVIEW: boolean = true;

/** The badge's text. */
export const GOVERNING_PREVIEW_LABEL = "Preview";

/** The one-line note beside the badge. */
export const GOVERNING_PREVIEW_NOTE =
  "Governing checks can miss rules or flag ones that don't apply. Review each finding before relying on it.";
