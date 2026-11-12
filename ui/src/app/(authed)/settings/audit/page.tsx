/**
 * #2337 — retired alias. It rendered Configuration with its Audit log tab open
 * but no navigation linked it; it now redirects there. See `lib/legacy-routes`.
 */
import { redirect } from "next/navigation";
import { legacyRedirect, type SearchParamsInput } from "@/lib/legacy-routes";

export default async function SettingsAuditRedirect({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  redirect(legacyRedirect("/settings/audit", await searchParams));
}
