/**
 * Issue #2437 — how many restricted files a run left out, and why.
 *
 * Since #2314 an analysis read code as a shared audience: everyone on the
 * project reads its results, so a file any access restriction covers was left
 * out, even when the person who started the run could read it. This line says
 * so: "3 restricted files weren't analysed: results are shared with the whole
 * project, so they include only what everyone on it can see." It shows counts
 * only, never a file's name (the record holds none), and renders nothing when
 * the run left nothing out.
 *
 * Issue #2448 — a run a person starts now reads code with their access, so it
 * leaves no restricted file out for that reason. When it read restricted files
 * the line says that instead: "This analysis read 3 restricted files with the
 * access of the person who ran it. Anyone who can't see one of them sees what
 * drew on it as restricted." Also counts only.
 *
 * Issue #2506 — such a run reads its documents with that access too, so it
 * leaves nothing out for the shared audience, and the line counts restricted
 * files and documents: "This analysis read 3 restricted files and documents
 * with the access of the person who ran it. ..."
 */
import {
  restrictedLeftOutSentence,
  restrictedReadSentence,
  type AnalysisCapability,
} from "@metis/shared";

interface Props {
  capability: AnalysisCapability | null | undefined;
  /** Tells two copies on one page apart in tests. */
  testId?: string;
}

export function RestrictedLeftOutNotice({
  capability,
  testId = "restricted-left-out",
}: Props): React.ReactElement | null {
  // The stored record is unchecked JSON: the shared readers shape-check it.
  const sentences = [
    restrictedLeftOutSentence(capability?.restrictedLeftOut),
    restrictedReadSentence(capability?.restrictedRead),
  ].filter((s): s is string => s !== null);
  if (sentences.length === 0) return null;
  return (
    // A note, not a live region (`status`): it is static summary text, and on a
    // run started from a Spec Kit handoff it renders twice on one page.
    <p className="text-xs text-warning" role="note" data-testid={testId}>
      {sentences.join(" ")}
    </p>
  );
}
