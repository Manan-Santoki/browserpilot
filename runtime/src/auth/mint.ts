import { SignJWT } from "jose";

const DEFAULT_TTL_SECONDS = 3600;

// Many applications validate that the session subject is a UUID before they
// trust the token. Checking here turns a silent rejection at the target into a
// clear failure at session start.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TargetUser = {
  userId: string;
  email: string;
  role: string;
  name: string;
};

export async function mintRobotCookie(
  user: TargetUser,
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
