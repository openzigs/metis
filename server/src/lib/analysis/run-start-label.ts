/**
 * How an analysis run is named to a reader: by its start time, never its id.
 * Shared by the publish epic title (#1064) and the requirements-scoped BRD
 * (#1170), so both name the same run the same way.
 *
 * "2026-09-29T14:05:33.000Z" → "2026-09-29 14:05:33 UTC" — to the second, so
 * runs started in the same minute stay apart. Null for a missing or invalid date.
 */
export function formatStartedAt(startedAt: Date | null | undefined): string | null {
  if (!(startedAt instanceof Date) || Number.isNaN(startedAt.getTime())) return null;
  return `${startedAt.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}
