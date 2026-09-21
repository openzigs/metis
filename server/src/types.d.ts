/**
 * Project-wide ambient type augmentations.
 *
 * Express exposes its `Request`/`Response`/etc. via the global `Express`
 * namespace; both `@types/express` and `@types/express-serve-static-core`
 * declare it that way. Augmenting through the global namespace avoids having
 * to import `express-serve-static-core` directly (which is a transitive type
 * dependency under pnpm and not always import-resolvable).
 */
import type { AuthPayload } from "@metis/shared";

declare global {
  namespace Express {
    // @types/passport declares an empty `Express.User` and augments
    // `Request.user` as `Express.User | undefined`. That wins over our
    // `Request.user?: AuthPayload` below unless we also extend `User`.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface User extends AuthPayload {}

    interface Request {
      /** Decoded JWT payload attached by `requireAuth` middleware. */
      user?: AuthPayload;
      /** ULID assigned by `requestLogger` for log correlation. */
      correlationId?: string;
    }
  }
}

export {};
