/**
 * #31 — Admin merged into Settings. Every `/admin/*` URL redirects to its
 * section of the one Settings area (or to the concept's one home).
 */
import { redirect } from "next/navigation";
import { legacyRedirect, type SearchParamsInput } from "@/lib/legacy-routes";

export default async function AdminRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ slug?: string[] }>;
  searchParams: Promise<SearchParamsInput>;
}) {
  const { slug = [] } = await params;
  const path = ["/admin", ...slug.map(encodeURIComponent)].join("/");
  redirect(legacyRedirect(path, await searchParams));
}
