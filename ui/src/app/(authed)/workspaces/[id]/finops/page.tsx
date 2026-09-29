/** #31 — workspace cost and budgets live on the one Usage page (Workspace scope). */
import { redirect } from "next/navigation";
import { legacyRedirect, type SearchParamsInput } from "@/lib/legacy-routes";

export default async function WorkspaceFinopsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SearchParamsInput>;
}) {
  const { id } = await params;
  redirect(legacyRedirect(`/workspaces/${id}/finops`, await searchParams));
}
