/**
 * Set a user's password from the server, for when nobody can get in.
 *
 *   bun run scripts/reset-password.ts <email> <new-password>
 *
 * Deliberately server-side only: there is no email delivery configured, so a
 * self-service "forgot password" flow would have nowhere to send a link.
 */
import { eq } from "drizzle-orm";
import { hashPassword } from "@browserpilot/core";
import { createDatabase, users } from "@browserpilot/db";

const [email, password] = process.argv.slice(2);

if (!email || !password) {
  console.error("Usage: bun run scripts/reset-password.ts <email> <new-password>");
  process.exit(1);
}

if (password.length < 12) {
  console.error("Choose a password of at least 12 characters.");
  process.exit(1);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const db = createDatabase(url, { max: 1 });

const [updated] = await db
  .update(users)
  .set({ passwordHash: await hashPassword(password), updatedAt: new Date() })
  .where(eq(users.email, email.trim().toLowerCase()))
  .returning({ id: users.id, email: users.email });

if (!updated) {
  console.error(`No account found for ${email}.`);
  process.exit(1);
}

console.log(`Password updated for ${updated.email}.`);
process.exit(0);
