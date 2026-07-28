import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createDatabase, users, siteProfiles, robotSessions } from "../src/client";

const url =
  process.env.DATABASE_URL ?? "postgresql://browserpilot:devpassword@127.0.0.1:55432/browserpilot";
const db = createDatabase(url, { max: 2 });

const stamp = Date.now();
const email = `roundtrip-${stamp}@test.local`;

afterAll(async () => {
  // Cascades clean up the session rows.
  await db.delete(users).where(eq(users.email, email));
  await db.delete(siteProfiles).where(eq(siteProfiles.name, `test-site-${stamp}`));
});

describe("schema round-trip", () => {
  test("a user can be written and read back with its defaults", async () => {
    const [created] = await db
      .insert(users)
      .values({ email, passwordHash: "x", name: "Round Trip" })
      .returning();

    expect(created!.role).toBe("USER");
    expect(created!.isActive).toBe(true);
    expect(created!.preferredLanguage).toBe("en");
    expect(created!.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("email is unique", async () => {
    // .execute() forces the builder into a real promise; the builder itself is
    // only a thenable. Drizzle wraps failures in a generic "Failed query"
    // error, so the Postgres constraint detail lives on .cause.
    const error = await db
      .insert(users)
      .values({ email, passwordHash: "y", name: "Duplicate" })
      .execute()
      .then(() => null)
      .catch((e: Error) => e);

    expect(error).not.toBeNull();
    expect(String((error as Error & { cause?: unknown }).cause)).toMatch(
      /duplicate key|unique/i,
    );
  });

  test("a site profile stores its secret only in the encrypted column", async () => {
    const [site] = await db
      .insert(siteProfiles)
      .values({
        name: `test-site-${stamp}`,
        baseUrl: "https://example.test",
        secretEncrypted: "ciphertext-goes-here",
        destructivePatterns: ["delete", "void"],
      })
      .returning();

    expect(site!.loginStrategy).toBe("cookie_mint");
    expect(site!.destructivePatterns).toEqual(["delete", "void"]);
    expect(Object.keys(site!)).not.toContain("secret");
  });

  test("a robot session links to its owner and site", async () => {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    const [site] = await db
      .select()
      .from(siteProfiles)
      .where(eq(siteProfiles.name, `test-site-${stamp}`));

    const [session] = await db
      .insert(robotSessions)
      .values({ userId: user!.id, siteProfileId: site!.id, title: "test run" })
      .returning();

    expect(session!.status).toBe("starting");

    const found = await db.query.robotSessions.findFirst({
      where: eq(robotSessions.id, session!.id),
    });
    expect(found?.userId).toBe(user!.id);
  });

  test("deleting a user cascades to their sessions", async () => {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    await db.delete(users).where(eq(users.id, user!.id));

    const left = await db
      .select()
      .from(robotSessions)
      .where(eq(robotSessions.userId, user!.id));
    expect(left).toHaveLength(0);
  });
});
