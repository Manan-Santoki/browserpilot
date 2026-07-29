/**
 * Creates the first administrator, since accounts are invite-only and there is
 * nobody to issue the first invite.
 *
 *   bun run scripts/create-admin.ts <email> <name> <password>
 *
 * Refuses to run once any admin exists — after that, invite from the console.
 */
import { eq } from "drizzle-orm";
import { hashPassword } from "@browserpilot/core";
import { createDatabase, users } from "@browserpilot/db";

const [email, name, password] = process.argv.slice(2);

if (!email || !name || !password) {
  console.error("Usage: bun run scripts/create-admin.ts <email> <name> <password>");
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

const existingAdmins = await db.select({ id: users.id }).from(users).where(eq(users.role, "ADMIN"));
if (existingAdmins.length > 0) {
  console.error(
    `An administrator already exists (${existingAdmins.length}). Invite further users from the console.`,
  );
  process.exit(1);
}

const [created] = await db
  .insert(users)
  .values({
    email: email.trim().toLowerCase(),
    name: name.trim(),
    passwordHash: await hashPassword(password),
    role: "ADMIN",
  })
  .returning({ id: users.id, email: users.email });

console.log(`Created administrator ${created!.email} (${created!.id}).`);
process.exit(0);
