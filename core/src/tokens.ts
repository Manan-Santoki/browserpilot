import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Opaque secrets — session cookies, invite links, device tokens, pairing codes.
 *
 * The plaintext is shown to the holder exactly once; only its SHA-256 digest is
 * stored. These are 256-bit random values rather than user-chosen passwords, so
 * a fast digest is appropriate: there is nothing to brute-force.
 */

export type TokenPair = {
  /** Give this to the holder. Never stored. */
  token: string;
  /** Store this. */
  hash: string;
};

export function generateToken(byteLength = 32): TokenPair {
  const token = randomBytes(byteLength).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison, so lookups cannot be timed to recover a token. */
export function tokensMatch(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashToken(token), "hex");
  const stored = Buffer.from(storedHash, "hex");
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}

/**
 * Short numeric-ish code for the pairing QR. Uses an unambiguous alphabet —
 * no 0/O or 1/I/L — because a human may end up reading it aloud or typing it.
 */
export function generatePairingCode(length = 8): TokenPair {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  const bytes = randomBytes(length);
  let code = "";
  for (let i = 0; i < length; i++) {
    code += alphabet[bytes[i]! % alphabet.length];
  }
  return { token: code, hash: hashToken(code) };
}
