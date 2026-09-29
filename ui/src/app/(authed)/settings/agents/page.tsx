/** #31 — retired route; see `lib/legacy-routes` for its one home. */
import { redirect } from "next/navigation";
import { legacyRedirect, type SearchParamsInput } from "@/lib/legacy-routes";

export default async function SettingsAgentsRedirect({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  redirect(legacyRedirect("/settings/agents", await searchParams));
}
