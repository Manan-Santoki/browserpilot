import { SignJWT, jwtVerify } from "jose";

/**
 * Session tickets: the console mints one, the browser presents it when opening
 * a WebSocket to the runtime, and the runtime verifies it.
 *
 * They are deliberately short-lived and single-session-scoped. A ticket is only
 * a handoff between two services that already trust each other via a shared
 * secret — it is not a login, and it grants nothing beyond one session.
 */

const DEFAULT_TTL_SECONDS = 60;

export type TicketClaims = {
  sessionId: string;
  userId: string;
  role: "ADMIN" | "USER";
};

export async function mintTicket(
  claims: TicketClaims,
  secret: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): Promise<string> {
  return new SignJWT({ ...claims })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .setAudience("browserpilot-runtime")
    .sign(new TextEncoder().encode(secret));
}

/** Returns the claims, or null for anything invalid, expired, or misaddressed. */
export async function verifyTicket(
  ticket: string,
  secret: string,
): Promise<TicketClaims | null> {
  try {
    const { payload } = await jwtVerify(ticket, new TextEncoder().encode(secret), {
      audience: "browserpilot-runtime",
    });

    const { sessionId, userId, role } = payload as Partial<TicketClaims>;
    if (typeof sessionId !== "string" || typeof userId !== "string") return null;
    if (role !== "ADMIN" && role !== "USER") return null;

    return { sessionId, userId, role };
  } catch {
    return null;
  }
}
