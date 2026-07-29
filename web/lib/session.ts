import "server-only";
import { cookies, headers } from "next/headers";
import { and, eq, gt, isNull } from "drizzle-orm";
import { generateToken, hashToken } from "@browserpilot/core";
import { users, webSessions } from "@browserpilot/db";
import { db } from "./db";

export const SESSION_COOKIE = "bp_session";
const SESSION_TTL_DAYS = 14;

/**
 * Whether to mark the session cookie `secure`.
 *
 * Derived from the console's own URL rather than NODE_ENV: a production build
 * served over plain HTTP would set a secure cookie the browser silently drops,
 * and login would fail with nothing to see in the logs.
 */
function secureCookie(): boolean {
  return (process.env.BP_WEB_URL ?? "").startsWith("https://");
}

export type CurrentUser = {
  id: string;
  email: string;
  name: string;
  role: "ADMIN" | "USER";
  preferredLanguage: string;
};

/**
 * Create a login session. The cookie holds a random 256-bit token; the database
 * stores only its digest, so a database leak cannot be replayed as a login.
 */
export async function createSession(userId: string): Promise<void> {
  const { token, hash } = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const headerList = await headers();
  await db().insert(webSessions).values({
    userId,
    tokenHash: hash,
    expiresAt,
    userAgent: headerList.get("user-agent")?.slice(0, 500) ?? null,
    ip: headerList.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
  });

  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: secureCookie(),
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Returns the signed-in user, or null. Never throws on a bad cookie. */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  const rows = await db()
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      preferredLanguage: users.preferredLanguage,
      isActive: users.isActive,
    })
    .from(webSessions)
    .innerJoin(users, eq(users.id, webSessions.userId))
    .where(
      and(
        eq(webSessions.tokenHash, hashToken(token)),
        gt(webSessions.expiresAt, new Date()),
        isNull(webSessions.revokedAt),
      ),
    )
    .limit(1);

  const found = rows[0];
  // A deactivated account keeps its session rows but must not be able to act.
  if (!found || !found.isActive) return null;

  return {
    id: found.id,
    email: found.email,
    name: found.name,
    role: found.role,
    preferredLanguage: found.preferredLanguage,
  };
}

export async function destroySession(): Promise<void> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;

  if (token) {
    await db()
      .update(webSessions)
      .set({ revokedAt: new Date() })
      .where(eq(webSessions.tokenHash, hashToken(token)));
  }

  cookieStore.delete(SESSION_COOKIE);
}
