/** #31 — a project's usage lives on the one Usage page (Project scope). */
import { redirect } from "next/navigation";
import { legacyRedirect, type SearchParamsInput } from "@/lib/legacy-routes";

export default async function ProjectUsageRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParamsInput>;
}) {
  const { id } = await params;
  redirect(legacyRedirect(`/projects/${id}/usage`, await searchParams));
}
