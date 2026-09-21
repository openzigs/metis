import { redirect } from "next/navigation";

/**
 * Root path redirects into the authenticated dashboard. Middleware will bounce
 * unauthenticated visitors to /login before this handler ever returns content.
 */
export default function RootIndex(): never {
  redirect("/dashboard");
}
