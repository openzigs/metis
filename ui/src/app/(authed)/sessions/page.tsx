/** #2350 — retired route: Sessions is chat's history list; see `lib/legacy-routes`. */
import { redirect } from "next/navigation";
import { legacyRedirect, type SearchParamsInput } from "@/lib/legacy-routes";

export default async function SessionsRedirect({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  redirect(legacyRedirect("/sessions", await searchParams));
}
