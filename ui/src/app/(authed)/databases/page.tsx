/**
 * #2353 — retired route: the cross-project database catalogue is gone. Each
 * project's Knowledge tab lists its own database connections; `?projectId=`
 * opens that project's, anything else the project list. See `lib/legacy-routes`.
 */
import { redirect } from "next/navigation";
import { legacyRedirect, type SearchParamsInput } from "@/lib/legacy-routes";

export default async function DatabasesRedirect({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  redirect(legacyRedirect("/databases", await searchParams));
}
