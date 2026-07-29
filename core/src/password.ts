import { argon2id, argon2Verify } from "hash-wasm";
import { randomBytes } from "node:crypto";

/**
 * Argon2id parameters. These are the OWASP-recommended second option
 * (19 MiB memory, 2 iterations, parallelism 1), which resists GPU cracking
 * while staying fast enough for an interactive login.
 *
 * hash-wasm is a WASM implementation rather than a native addon, so the same
 * code runs in Bun and Node without a compile step — the console and the
 * runtime share this module.
 */
const MEMORY_KIB = 19456;
const ITERATIONS = 2;
const PARALLELISM = 1;
const HASH_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0) throw new Error("Password must not be empty");
  return argon2id({
    password,
    salt: randomBytes(SALT_LENGTH),
    memorySize: MEMORY_KIB,
    iterations: ITERATIONS,
    parallelism: PARALLELISM,
    hashLength: HASH_LENGTH,
    outputType: "encoded",
  });
}

/**
 * Verify a password against a stored hash. Returns false rather than throwing
 * on a malformed hash, so a corrupt row cannot turn into a 500 on the login
 * path (and cannot be used to distinguish "bad hash" from "wrong password").
 */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password, hash });
  } catch {
    return false;
  }
}
