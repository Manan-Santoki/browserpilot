/**
 * Move downloads from the old on-disk layout into the object store.
 *
 * Files used to be served straight off `<downloads>/<sessionId>/<file>`. They
 * are now objects keyed `sessions/<sessionId>/<file>`, so that a deployment can
 * put them in a bucket instead of on a container's disk. Anything downloaded
 * before that change is still on disk under the old shape and would 404.
 *
 *   bun run scripts/migrate-downloads.ts [--delete]
 *
 * Reads the same settings the runtime does, so it copies into whichever store
 * is configured. Pass --delete to remove the originals once they are stored;
 * without it they are left in place and the migration can simply be re-run.
 */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { contentTypeFor } from "../core/src/content-type";
import { Store } from "../runtime/src/store";
import { createLocalStore, createS3Store, objectKey } from "../runtime/src/storage/object-store";
import { storageEnv } from "../runtime/src/storage/settings";

const databaseUrl = process.env.DATABASE_URL;
const masterKey = process.env.BP_MASTER_KEY;
const downloadsRoot = process.env.BP_DOWNLOADS_DIR?.trim() || "./downloads";
const removeOriginals = process.argv.includes("--delete");

if (!databaseUrl || !masterKey) {
  console.error("DATABASE_URL and BP_MASTER_KEY are required.");
  process.exit(1);
}

console.log("connecting…");
const store = new Store(databaseUrl, masterKey);
const settings = await store.storageSettings(storageEnv(process.env));
const objects =
  settings.driver === "s3" ? createS3Store(settings.s3) : createLocalStore(downloadsRoot);

console.log(`Storing into: ${objects.kind}${settings.driver === "s3" ? ` (${settings.s3.bucket})` : ` (${downloadsRoot})`}`);

let sessions: string[];
try {
  sessions = await readdir(downloadsRoot);
} catch {
  console.log(`Nothing at ${downloadsRoot} — nothing to migrate.`);
  process.exit(0);
}

let moved = 0;
let skipped = 0;

for (const sessionId of sessions) {
  // The new layout lives under this same root when storing locally; do not
  // migrate it into itself.
  if (sessionId === "sessions") continue;

  const dir = join(downloadsRoot, sessionId);
  const info = await stat(dir).catch(() => undefined);
  if (!info?.isDirectory()) continue;

  for (const filename of await readdir(dir).catch(() => [])) {
    const source = join(dir, filename);
    const file = await stat(source).catch(() => undefined);
    if (!file?.isFile()) continue;

    const key = objectKey(sessionId, filename);
    if (await objects.head(key)) {
      skipped++;
      continue;
    }

    await objects.put(key, source, contentTypeFor(filename));
    moved++;
    if (removeOriginals) await rm(source, { force: true });
  }
}

console.log(`Migrated ${moved} file(s); ${skipped} were already stored.`);
if (moved > 0 && !removeOriginals) {
  console.log("Originals kept. Re-run with --delete once you are satisfied.");
}

process.exit(0);
