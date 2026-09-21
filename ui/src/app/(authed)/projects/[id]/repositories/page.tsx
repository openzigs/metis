/**
 * #1371 — `/projects/{id}/repositories` 404'd: only the nested
 * `repositories/[repoId]/scanner` route existed, so the segment had no index
 * page. The real surface is `/connections`; anything linking to the old path
 * now lands there instead of on a dead route.
 */
import { redirect } from "next/navigation";

export default async function ProjectRepositoriesRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<never> {
  const { id } = await params;
  redirect(`/projects/${encodeURIComponent(id)}/connections`);
}
