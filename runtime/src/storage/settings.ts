import type { S3Config } from "./object-store";

/**
 * Where this deployment keeps session downloads.
 *
 * Two sources feed it: the environment, which is how the bundled MinIO is
 * wired up at deploy time, and the settings table, which is how an
 * administrator points the whole thing at their own bucket instead. The
 * database wins where it says anything, so a change in the console takes
 * effect without a redeploy.
 */
export type StorageSettings =
  | { driver: "local" }
  | { driver: "s3"; s3: S3Config };

export type StorageRow = { key: string; value: unknown };

/** Settings keys an administrator can write. The secret is stored sealed. */
export const STORAGE_KEYS = [
  "storageDriver",
  "s3Endpoint",
  "s3Region",
  "s3Bucket",
  "s3AccessKeyId",
  "s3SecretAccessKey",
  "s3ForcePathStyle",
] as const;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export type StorageEnv = {
  BP_S3_ENDPOINT?: string;
  BP_S3_REGION?: string;
  BP_S3_BUCKET?: string;
  BP_S3_ACCESS_KEY_ID?: string;
  BP_S3_SECRET_ACCESS_KEY?: string;
  BP_S3_FORCE_PATH_STYLE?: string;
};

/** Pick the storage variables out of a process environment. */
export function storageEnv(env: Record<string, string | undefined>): StorageEnv {
  return {
    BP_S3_ENDPOINT: env.BP_S3_ENDPOINT,
    BP_S3_REGION: env.BP_S3_REGION,
    BP_S3_BUCKET: env.BP_S3_BUCKET,
    BP_S3_ACCESS_KEY_ID: env.BP_S3_ACCESS_KEY_ID,
    BP_S3_SECRET_ACCESS_KEY: env.BP_S3_SECRET_ACCESS_KEY,
    BP_S3_FORCE_PATH_STYLE: env.BP_S3_FORCE_PATH_STYLE,
  };
}

/**
 * Resolve the two sources into one answer.
 *
 * `unseal` is passed in rather than a key: this module should not be able to
 * decrypt anything on its own, and the caller already holds the master key.
 * Anything short of a complete S3 configuration falls back to local files —
 * a half-configured bucket that silently swallowed downloads would be worse
 * than plainly keeping them on disk.
 */
export function resolveStorageSettings(
  rows: StorageRow[],
  env: StorageEnv,
  unseal: (sealed: string) => string,
): StorageSettings {
  const stored = new Map(rows.map((row) => [row.key, row.value]));

  const endpoint = text(stored.get("s3Endpoint")) ?? text(env.BP_S3_ENDPOINT);
  const region = text(stored.get("s3Region")) ?? text(env.BP_S3_REGION) ?? "us-east-1";
  const bucket = text(stored.get("s3Bucket")) ?? text(env.BP_S3_BUCKET);
  const accessKeyId = text(stored.get("s3AccessKeyId")) ?? text(env.BP_S3_ACCESS_KEY_ID);

  const sealed = text(stored.get("s3SecretAccessKey"));
  let secretAccessKey: string | undefined;
  if (sealed) {
    try {
      secretAccessKey = unseal(sealed);
    } catch {
      // A secret that will not unseal is a secret we do not have.
      secretAccessKey = undefined;
    }
  } else {
    secretAccessKey = text(env.BP_S3_SECRET_ACCESS_KEY);
  }

  const driver = text(stored.get("storageDriver"));
  if (driver === "local") return { driver: "local" };

  if (!bucket || !accessKeyId || !secretAccessKey) return { driver: "local" };

  const forcePathStyleRaw =
    stored.get("s3ForcePathStyle") ?? text(env.BP_S3_FORCE_PATH_STYLE) ?? true;
  const forcePathStyle =
    typeof forcePathStyleRaw === "boolean" ? forcePathStyleRaw : forcePathStyleRaw !== "false";

  return {
    driver: "s3",
    s3: { endpoint, region, bucket, accessKeyId, secretAccessKey, forcePathStyle },
  };
}

/** What the console may show about the current configuration. Never the key. */
export function describeStorage(settings: StorageSettings): {
  driver: "local" | "s3";
  endpoint?: string;
  bucket?: string;
  region?: string;
} {
  if (settings.driver === "local") return { driver: "local" };
  return {
    driver: "s3",
    endpoint: settings.s3.endpoint,
    bucket: settings.s3.bucket,
    region: settings.s3.region,
  };
}
