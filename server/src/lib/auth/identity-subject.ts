/**
 * #1395 — the subject for a directory account known only by name: NFKC-folded
 * and lower-cased like `bootstrap-admins.ts`, so `Alice` and `alice` are one
 * identity. Prefixed so it cannot collide with a directory's canonical id
 * (`entryUUID:` / `objectGUID:`, `ldap-provider.ts`).
 *
 * Its own module so `ldap-provider.ts` can use it without loading Prisma.
 */
import { foldIdentity } from "./bootstrap-admins.js";

export function directoryNameSubject(name: string): string {
  return `name:${foldIdentity(name)}`;
}
