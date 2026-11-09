/**
 * #2109 — the Preview badge and its one-line note, wherever an analyst meets
 * governing checks: the workspace Governing documents tab and the analysis
 * view's Governing rules panel. The BRD's section carries the same note.
 *
 * Whether it shows is `GOVERNING_PREVIEW` in `@metis/shared`, the one setting
 * for every surface; this renders nothing when it is off.
 */
import { GOVERNING_PREVIEW, GOVERNING_PREVIEW_LABEL, GOVERNING_PREVIEW_NOTE } from "@metis/shared";
import { Badge } from "@/components/ui/badge";

export function GoverningPreviewNotice({
  className = "",
}: {
  className?: string;
}): React.ReactElement | null {
  if (!GOVERNING_PREVIEW) return null;
  // A `<div>`, not a `<p>`: `Badge` renders a `<div>`, which a `<p>` cannot hold.
  return (
    <div
      className={`flex flex-wrap items-center gap-2 text-sm text-muted-foreground ${className}`}
      role="note"
      data-testid="governing-preview"
    >
      <Badge variant="warning">{GOVERNING_PREVIEW_LABEL}</Badge>
      <span>{GOVERNING_PREVIEW_NOTE}</span>
    </div>
  );
}
