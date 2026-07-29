import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Chromium profiles captured when a person signs in to a target site themselves.
 *
 * Chromium takes an exclusive lock on a profile directory, so launching every
 * session straight from the canonical profile would allow only one browser per
 * site per person — and concurrency is the whole point of running these on a
 * server. Instead the canonical profile is a template: each session gets its
 * own copy, and only a deliberate login writes the template back.
 *
 * A profile holds live logins, so it is as sensitive as a password. It is
 * files on a volume rather than a sealed database column, which is the cost of
 * keeping everything a login leaves behind — IndexedDB, service workers, and
 * the device identity a site may have bound the session to.
 */

/** Files that carry the login. Everything else in a profile is cache. */
const STATEFUL_ENTRIES = [
  "Default/Cookies",
  "Default/Cookies-journal",
  "Default/Local Storage",
  "Default/Session Storage",
  "Default/IndexedDB",
  "Default/Service Worker",
  "Default/Local State",
  "Local State",
];

/** Locks that a copied-from profile leaves behind and a fresh launch rejects. */
const LOCK_ENTRIES = ["SingletonLock", "SingletonSocket", "SingletonCookie", "lockfile"];

export type ProfileStore = {
  /** Where the canonical profile for this person-and-site lives. */
  path(siteProfileId: string, userId: string): string;
  exists(siteProfileId: string, userId: string): Promise<boolean>;
  /** A fresh directory for a login session to write into. */
  prepareForLogin(siteProfileId: string, userId: string): Promise<string>;
  /** A disposable copy for an agent session to run from. */
  checkout(siteProfileId: string, userId: string, into: string): Promise<void>;
  /** Write a finished session's login state back to the canonical profile. */
  syncBack(siteProfileId: string, userId: string, from: string): Promise<void>;
  remove(siteProfileId: string, userId: string): Promise<void>;
};

export function createProfileStore(root: string): ProfileStore {
  // One in-flight write per profile. Sessions for the same site can end at the
  // same moment, and two concurrent copies into one directory interleave into
  // a profile that belongs to neither.
  const writing = new Map<string, Promise<unknown>>();

  function path(siteProfileId: string, userId: string): string {
    return join(root, siteProfileId, userId);
  }

  function serialise<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = writing.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    writing.set(
      key,
      next.catch(() => {}),
    );
    return next;
  }

  async function copyStatefulEntries(from: string, to: string): Promise<void> {
    await mkdir(join(to, "Default"), { recursive: true });
    for (const entry of STATEFUL_ENTRIES) {
      const source = join(from, entry);
      if (!(await exists(source))) continue;
      await cp(source, join(to, entry), { recursive: true, force: true });
    }
  }

  return {
    path,

    async exists(siteProfileId, userId) {
      return exists(path(siteProfileId, userId));
    },

    async prepareForLogin(siteProfileId, userId) {
      const dir = path(siteProfileId, userId);
      // Signing in again replaces the old login rather than layering on top of
      // it; a half-replaced profile is how you get a session that is neither.
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      return dir;
    },

    async checkout(siteProfileId, userId, into) {
      const source = path(siteProfileId, userId);
      if (!(await exists(source))) {
        throw new Error("No saved login for this site");
      }

      await mkdir(into, { recursive: true });
      await cp(source, into, { recursive: true, force: true });

      // The template was copied from a browser that once ran; its leftover
      // singleton locks would make Chromium refuse to start here.
      for (const lock of LOCK_ENTRIES) {
        await rm(join(into, lock), { recursive: true, force: true }).catch(() => {});
      }
    },

    async syncBack(siteProfileId, userId, from) {
      const destination = path(siteProfileId, userId);
      if (!(await exists(destination))) return; // unlinked while the session ran

      // Only the login-bearing files. Copying the whole directory back would
      // carry a session's cache and history into every later session.
      await serialise(destination, () => copyStatefulEntries(from, destination));
    },

    async remove(siteProfileId, userId) {
      const dir = path(siteProfileId, userId);
      await serialise(dir, () => rm(dir, { recursive: true, force: true }));
    },
  };
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
