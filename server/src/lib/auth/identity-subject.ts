/**
 * #1395 — the subject for a directory account known only by name: NFKC-folded
 * and lower-cased like `bootstrap-admins.ts`, so `Alice` and `alice` are one
 * identity. Prefixed so it cannot collide with a directory's canonical id
 * (`entryUUID:` / `objectGUID:`, `ldap-provider.ts`).
 *
 * A name that NFKC would change is never folded (as `bootstrap-admins.ts`
 * refuses it as a candidate): `"Kate"` (Kelvin sign) would otherwise share
 * `kate`'s identity. It keys under its own prefix, exactly as given.
 *
 * Its own module so `ldap-provider.ts` can use it without loading Prisma.
 */
import { foldIdentity, isNfkcStable } from "./bootstrap-admins.js";

export function directoryNameSubject(name: string): string {
  return isNfkcStable(name) ? `name:${foldIdentity(name)}` : `name-exact:${name}`;
}
