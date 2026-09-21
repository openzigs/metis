/**
 * User session validation (METIS requirement→code mapping eval fixture).
 */
export function createUserSession(userId) {
  return { userId, token: `session-${userId}`, valid: true };
}

export function validateUserSession(session) {
  return Boolean(session && session.valid);
}
