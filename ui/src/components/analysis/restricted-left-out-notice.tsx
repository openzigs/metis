/**
 * Issue #2437 — how many restricted files a run left out, and why.
 *
 * Since #2314 an analysis reads code as a shared audience: everyone on the
 * project reads its results, so a file any access restriction covers is left
 * out, even when the person who started the run could read it. This line says
 * so: "3 restricted files weren't analysed: results are shared with the whole
 * project, so they include only what everyone on it can see." It shows counts
 * only, never a file's name (the record holds none), and renders nothing when
 * the run left nothing out.
 */
import { restrictedLeftOutSentence, type AnalysisCapability } from "@metis/shared";

interface Props {
  capability: AnalysisCapability | null | undefined;
  /** Tells two copies on one page apart in tests. */
  testId?: string;
}

export function RestrictedLeftOutNotice({
  capability,
  testId = "restricted-left-out",
}: Props): React.ReactElement | null {
  // The stored record is unchecked JSON: the shared reader shape-checks it.
  const sentence = restrictedLeftOutSentence(capability?.restrictedLeftOut);
  if (!sentence) return null;
  return (
    <p className="text-xs text-warning" role="status" data-testid={testId}>
      {sentence}
    </p>
  );
}
