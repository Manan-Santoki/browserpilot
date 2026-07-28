import { SignJWT } from "jose";

export const ROBOT_COOKIE_NAME = "jwm-session";

const DEFAULT_TTL_SECONDS = 3600;

// Mirrors JWM's isValidSessionPayload check in lib/auth.ts — a token whose
// userId fails this pattern is rejected by JWM even though it verifies.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type JwmUser = {
  userId: string;
  email: string;
  role: string;
  name: string;
};

export async function mintRobotCookie(
  user: JwmUser,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  if (!UUID_PATTERN.test(user.userId)) {
    throw new Error("userId must be a UUID");
  }
  return new SignJWT({ ...user, robot: true })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(new TextEncoder().encode(secret));
}
