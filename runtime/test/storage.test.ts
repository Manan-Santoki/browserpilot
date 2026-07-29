import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalStore, isSafeKey, objectKey } from "../src/storage/object-store";
import { describeStorage, resolveStorageSettings } from "../src/storage/settings";

const unseal = (sealed: string) => {
  if (sealed === "bad") throw new Error("cannot unseal");
  return sealed.replace(/^sealed:/, "");
};

describe("choosing where downloads go", () => {
  test("the environment alone is enough to reach the bundled bucket", () => {
    const settings = resolveStorageSettings(
      [],
      {
        BP_S3_ENDPOINT: "http://minio:9000",
        BP_S3_BUCKET: "browserpilot",
        BP_S3_ACCESS_KEY_ID: "key",
        BP_S3_SECRET_ACCESS_KEY: "secret",
      },
      unseal,
    );

    expect(settings.driver).toBe("s3");
    if (settings.driver !== "s3") throw new Error("unreachable");
    expect(settings.s3.bucket).toBe("browserpilot");
    // MinIO addresses buckets by path unless told otherwise.
    expect(settings.s3.forcePathStyle).toBe(true);
  });

  test("what an administrator saved wins over what was deployed", () => {
    const settings = resolveStorageSettings(
      [
        { key: "s3Endpoint", value: "https://s3.eu-west-2.amazonaws.com" },
        { key: "s3Bucket", value: "their-own-bucket" },
        { key: "s3AccessKeyId", value: "their-key" },
        { key: "s3SecretAccessKey", value: "sealed:their-secret" },
        { key: "s3ForcePathStyle", value: false },
      ],
      { BP_S3_BUCKET: "browserpilot", BP_S3_ACCESS_KEY_ID: "k", BP_S3_SECRET_ACCESS_KEY: "s" },
      unseal,
    );

    if (settings.driver !== "s3") throw new Error("expected s3");
    expect(settings.s3.bucket).toBe("their-own-bucket");
    expect(settings.s3.secretAccessKey).toBe("their-secret");
    expect(settings.s3.forcePathStyle).toBe(false);
  });

  test("a half-configured bucket keeps files on disk rather than losing them", () => {
    // Bucket named, but nothing to authenticate with.
    const settings = resolveStorageSettings([{ key: "s3Bucket", value: "half" }], {}, unseal);
    expect(settings.driver).toBe("local");
  });

  test("a secret that will not unseal is a secret we do not have", () => {
    const settings = resolveStorageSettings(
      [
        { key: "s3Bucket", value: "b" },
        { key: "s3AccessKeyId", value: "k" },
        { key: "s3SecretAccessKey", value: "bad" },
      ],
      {},
      unseal,
    );
    expect(settings.driver).toBe("local");
  });

  test("an administrator can switch back to disk with a bucket still configured", () => {
    const settings = resolveStorageSettings(
      [
        { key: "storageDriver", value: "local" },
        { key: "s3Bucket", value: "b" },
        { key: "s3AccessKeyId", value: "k" },
        { key: "s3SecretAccessKey", value: "sealed:s" },
      ],
      {},
      unseal,
    );
    expect(settings.driver).toBe("local");
  });

  test("what the console is told never includes the key", () => {
    const described = describeStorage({
      driver: "s3",
      s3: { bucket: "b", accessKeyId: "k", secretAccessKey: "very-secret", endpoint: "http://m" },
    });
    expect(JSON.stringify(described)).not.toContain("very-secret");
    expect(described.bucket).toBe("b");
  });
});

describe("object keys", () => {
  test("everything one session produced shares a prefix", () => {
    expect(objectKey("abc", "order.pdf")).toBe("sessions/abc/order.pdf");
  });

  test("a filename from the target site cannot climb out", () => {
    // Content-Disposition is attacker-influenced, so these are real inputs.
    expect(isSafeKey("sessions/a/../../etc/passwd")).toBe(false);
    expect(isSafeKey("/etc/passwd")).toBe(false);
    expect(isSafeKey("sessions/a/..")).toBe(false);
    expect(isSafeKey("sessions//a.pdf")).toBe(false);
    expect(isSafeKey("sessions\\a\\b.pdf")).toBe(false);
    expect(isSafeKey("sessions/a/b.pdf")).toBe(true);
  });

  test("the local driver refuses to write outside its root", async () => {
    const root = await mkdtemp(join(tmpdir(), "bp-store-"));
    const store = createLocalStore(join(root, "files"));
    const sample = join(root, "sample.txt");
    await Bun.write(sample, "hello");

    await expect(store.put("../escaped.txt", sample)).rejects.toThrow(/unsafe/i);
    await rm(root, { recursive: true, force: true });
  });
});
