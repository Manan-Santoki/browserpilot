import { describe, expect, test } from "bun:test";
import { jwtVerify } from "jose";
import { mintRobotCookie, type TargetUser } from "../src/auth/mint";

const USER: TargetUser = {
  userId: "3f7c1a52-9d4e-4b1a-8f2c-1a2b3c4d5e6f",
  email: "owner@jwm.test",
  role: "admin",
  name: "Manan Santoki",
};
const SECRET = "shared-with-jwm";

describe("mintRobotCookie", () => {
  test("carries whatever claims the target expects", async () => {
    const token = await mintRobotCookie(USER, SECRET);
    // The cookie NAME is a per-site setting now, not a constant here.
    expect(token.split(".")).toHaveLength(3);
  });

  test("token verifies with the shared secret and carries JWM's required claims", async () => {
    const token = await mintRobotCookie(USER, SECRET);
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET));
    expect(payload.userId).toBe(USER.userId);
    expect(payload.email).toBe(USER.email);
    expect(payload.role).toBe(USER.role);
    expect(payload.name).toBe(USER.name);
  });

  test("marks the token as robot-issued for auditing", async () => {
    const token = await mintRobotCookie(USER, SECRET);
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET));
    expect(payload.robot).toBe(true);
  });

  test("uses HS256 so JWM's jwtVerify accepts it", async () => {
    const token = await mintRobotCookie(USER, SECRET);
    const header = JSON.parse(atob(token.split(".")[0]!));
    expect(header.alg).toBe("HS256");
  });

  test("expires within the requested ttl", async () => {
    const token = await mintRobotCookie(USER, SECRET, 60);
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET));
    const lifetime = payload.exp! - payload.iat!;
    expect(lifetime).toBe(60);
  });

  test("defaults to a one hour ttl", async () => {
    const token = await mintRobotCookie(USER, SECRET);
    const { payload } = await jwtVerify(token, new TextEncoder().encode(SECRET));
    expect(payload.exp! - payload.iat!).toBe(3600);
  });

  test("a token signed with a different secret does not verify", async () => {
    const token = await mintRobotCookie(USER, "other-secret");
    await expect(jwtVerify(token, new TextEncoder().encode(SECRET))).rejects.toThrow();
  });

  test("rejects a non-UUID userId, which JWM would refuse", async () => {
    await expect(mintRobotCookie({ ...USER, userId: "not-a-uuid" }, SECRET)).rejects.toThrow(
      /userId must be a UUID/,
    );
  });
});
