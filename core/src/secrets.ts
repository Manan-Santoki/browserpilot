import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

/**
 * Encryption for per-site secrets (a target's cookie-mint signing key).
 *
 * These are stored in the database but must not be readable from a database
 * dump alone, so they are sealed with AES-256-GCM under a master key held only
 * in the environment. GCM is authenticated: tampering with the ciphertext makes
 * decryption fail rather than silently returning garbage.
 *
 * Format: v1.<iv>.<authTag>.<ciphertext>, all base64url. The version prefix
 * exists so the scheme can be rotated later without guessing at old rows.
 */

const VERSION = "v1";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const BINARY_MAGIC = Buffer.from("BPB1", "ascii");

function deriveKey(masterKey: string): Buffer {
  if (masterKey.length < 32) {
    throw new Error("Master key must be at least 32 characters");
  }
  // A SHA-256 of the configured key gives AES-256 exactly 32 bytes regardless
  // of how the operator formatted it (hex, base64, passphrase).
  return createHash("sha256").update(masterKey).digest();
}

export function encryptSecret(plaintext: string, masterKey: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterKey), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64url"),
    authTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptSecret(sealed: string, masterKey: string): string {
  const parts = sealed.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed sealed secret");
  }

  const [, ivPart, tagPart, ciphertextPart] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(masterKey),
    Buffer.from(ivPart!, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tagPart!, "base64url"));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextPart!, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

/**
 * Seal private documents without first turning them into base64 or text.
 * Wire format: `BPB1` magic, 12-byte IV, 16-byte GCM tag, then ciphertext.
 * Optional AAD binds a blob to its owner/document identity.
 */
export function encryptBinary(
  plaintext: Uint8Array,
  masterKey: string,
  aad?: string,
): Uint8Array {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(masterKey), iv);
  if (aad) cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([BINARY_MAGIC, iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptBinary(
  sealed: Uint8Array,
  masterKey: string,
  aad?: string,
): Uint8Array {
  const bytes = Buffer.from(sealed);
  const headerLength = BINARY_MAGIC.length + IV_LENGTH + AUTH_TAG_LENGTH;
  if (bytes.length < headerLength || !bytes.subarray(0, BINARY_MAGIC.length).equals(BINARY_MAGIC)) {
    throw new Error("Malformed sealed binary");
  }
  const ivStart = BINARY_MAGIC.length;
  const tagStart = ivStart + IV_LENGTH;
  const dataStart = tagStart + AUTH_TAG_LENGTH;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(masterKey),
    bytes.subarray(ivStart, tagStart),
  );
  if (aad) decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(bytes.subarray(tagStart, dataStart));
  return Buffer.concat([decipher.update(bytes.subarray(dataStart)), decipher.final()]);
}

export function encryptStructured(value: unknown, masterKey: string): string {
  return encryptSecret(JSON.stringify(value), masterKey);
}

export function decryptStructured<T>(sealed: string, masterKey: string): T {
  return JSON.parse(decryptSecret(sealed, masterKey)) as T;
}
