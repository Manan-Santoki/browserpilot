import { describe, expect, test } from "bun:test";
import { hashPassword, verifyPassword } from "../src/password";
import { generatePairingCode, generateToken, hashToken, tokensMatch } from "../src/tokens";
import {
  decryptBinary,
  decryptSecret,
  decryptStructured,
  encryptBinary,
  encryptSecret,
  encryptStructured,
} from "../src/secrets";
import { mintTicket, verifyTicket } from "../src/tickets";

const MASTER_KEY = "a".repeat(32);
const TICKET_SECRET = "ticket-signing-secret-value";

describe("password hashing", () => {
  test("a correct password verifies", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  test("a wrong password does not", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("Correct horse battery staple", hash)).toBe(false);
  });

  test("the same password hashes differently each time", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  test("the hash is argon2id, not a bare digest", async () => {
    expect(await hashPassword("x")).toStartWith("$argon2id$");
  });

  test("an empty password is rejected outright", async () => {
    await expect(hashPassword("")).rejects.toThrow(/must not be empty/i);
  });

  test("a corrupt stored hash returns false rather than throwing", async () => {
    expect(await verifyPassword("anything", "not-a-hash")).toBe(false);
  });

  test("unicode passwords survive the round trip", async () => {
    const password = "ગુજરાતી-पासवर्ड-🔐";
    expect(await verifyPassword(password, await hashPassword(password))).toBe(true);
  });
});

describe("tokens", () => {
  test("a generated token matches its own hash", () => {
    const { token, hash } = generateToken();
    expect(tokensMatch(token, hash)).toBe(true);
  });

  test("a different token does not match", () => {
    const { hash } = generateToken();
    const other = generateToken();
    expect(tokensMatch(other.token, hash)).toBe(false);
  });

  test("tokens are unique across generations", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateToken().token));
    expect(seen.size).toBe(200);
  });

  test("hashing is stable and never returns the token itself", () => {
    const { token, hash } = generateToken();
    expect(hashToken(token)).toBe(hash);
    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a malformed stored hash does not throw", () => {
    expect(tokensMatch("whatever", "short")).toBe(false);
  });

  test("pairing codes avoid ambiguous characters", () => {
    for (let i = 0; i < 50; i++) {
      expect(generatePairingCode().token).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });
});

describe("site secret encryption", () => {
  test("round-trips a secret", () => {
    const sealed = encryptSecret("the-target-signing-secret", MASTER_KEY);
    expect(decryptSecret(sealed, MASTER_KEY)).toBe("the-target-signing-secret");
  });

  test("the plaintext never appears in the ciphertext", () => {
    const sealed = encryptSecret("super-secret-value", MASTER_KEY);
    expect(sealed).not.toContain("super-secret-value");
    expect(sealed).toStartWith("v1.");
  });

  test("encrypting twice yields different ciphertext", () => {
    const a = encryptSecret("same", MASTER_KEY);
    const b = encryptSecret("same", MASTER_KEY);
    expect(a).not.toBe(b);
  });

  test("the wrong master key cannot decrypt", () => {
    const sealed = encryptSecret("secret", MASTER_KEY);
    expect(() => decryptSecret(sealed, "b".repeat(32))).toThrow();
  });

  test("tampered ciphertext is rejected rather than silently wrong", () => {
    const sealed = encryptSecret("secret", MASTER_KEY);
    const parts = sealed.split(".");
    const flipped = Buffer.from(parts[3]!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    parts[3] = flipped.toString("base64url");
    expect(() => decryptSecret(parts.join("."), MASTER_KEY)).toThrow();
  });

  test("a short master key is refused", () => {
    expect(() => encryptSecret("secret", "too-short")).toThrow(/at least 32/i);
  });

  test("malformed input is refused", () => {
    expect(() => decryptSecret("garbage", MASTER_KEY)).toThrow(/malformed/i);
  });
});

describe("private job data encryption", () => {
  test("binary documents round-trip without exposing plaintext", () => {
    const plaintext = new TextEncoder().encode("private résumé bytes");
    const sealed = encryptBinary(plaintext, MASTER_KEY, "user-1/document-1");
    expect(new TextDecoder().decode(sealed)).not.toContain("private résumé bytes");
    expect(decryptBinary(sealed, MASTER_KEY, "user-1/document-1")).toEqual(plaintext);
  });

  test("binary documents are bound to their owner and reject tampering", () => {
    const sealed = encryptBinary(new Uint8Array([1, 2, 3]), MASTER_KEY, "owner-a");
    expect(() => decryptBinary(sealed, MASTER_KEY, "owner-b")).toThrow();
    sealed[sealed.length - 1] = sealed[sealed.length - 1]! ^ 1;
    expect(() => decryptBinary(sealed, MASTER_KEY, "owner-a")).toThrow();
  });

  test("structured candidate values retain their types", () => {
    const sealed = encryptStructured({ salary: 120000, relocate: false, locations: ["Remote"] }, MASTER_KEY);
    expect(decryptStructured<{ salary: number; relocate: boolean; locations: string[] }>(sealed, MASTER_KEY))
      .toEqual({ salary: 120000, relocate: false, locations: ["Remote"] });
  });
});

describe("session tickets", () => {
  const claims = { sessionId: "sess-1", userId: "user-1", role: "USER" as const };

  test("a freshly minted ticket verifies", async () => {
    const ticket = await mintTicket(claims, TICKET_SECRET);
    expect(await verifyTicket(ticket, TICKET_SECRET)).toEqual(claims);
  });

  test("a ticket signed with another secret is rejected", async () => {
    const ticket = await mintTicket(claims, "different-secret");
    expect(await verifyTicket(ticket, TICKET_SECRET)).toBeNull();
  });

  test("an expired ticket is rejected", async () => {
    const ticket = await mintTicket(claims, TICKET_SECRET, -1);
    expect(await verifyTicket(ticket, TICKET_SECRET)).toBeNull();
  });

  test("garbage is rejected without throwing", async () => {
    expect(await verifyTicket("not.a.jwt", TICKET_SECRET)).toBeNull();
  });

  test("tickets carry the session they are scoped to", async () => {
    const ticket = await mintTicket({ ...claims, sessionId: "sess-9" }, TICKET_SECRET);
    const verified = await verifyTicket(ticket, TICKET_SECRET);
    expect(verified?.sessionId).toBe("sess-9");
  });
});
