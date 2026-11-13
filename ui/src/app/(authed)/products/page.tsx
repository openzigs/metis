/**
 * #2353 — retired route: the products list is a section of the Portfolio tab.
 * A product's own page (`/products/<id>`) kept its URL. See `lib/legacy-routes`.
 */
import { redirect } from "next/navigation";
import { legacyRedirect, type SearchParamsInput } from "@/lib/legacy-routes";

export default async function ProductsRedirect({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  redirect(legacyRedirect("/products", await searchParams));
}
