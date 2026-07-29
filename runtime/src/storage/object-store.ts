import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

/**
 * Where a session's downloads live.
 *
 * Container disk is the wrong home for them: a redeploy takes the files with
 * it, and they are the part of a session a person comes back for. The runtime
 * therefore writes them through this interface, which is either object storage
 * or — for a local checkout with nothing configured — a directory.
 *
 * Keys look like `sessions/<sessionId>/<filename>`, so everything a session
 * produced shares a prefix and can be listed or removed together.
 */
export type StoredObject = {
  key: string;
  size: number;
  updatedAt: Date;
};

export type ObjectStore = {
  readonly kind: "local" | "s3";
  put(key: string, filePath: string, contentType?: string): Promise<void>;
  /** Undefined rather than throwing: a missing file is a 404, not a fault. */
  get(key: string): Promise<ReadableStream<Uint8Array> | undefined>;
  head(key: string): Promise<StoredObject | undefined>;
  list(prefix: string): Promise<StoredObject[]>;
  delete(key: string): Promise<void>;
};

export function objectKey(sessionId: string, filename: string): string {
  return `sessions/${sessionId}/${filename}`;
}

/**
 * Refuse a key that would climb out of its prefix.
 *
 * Filenames come from the target site by way of Content-Disposition, so they
 * are attacker-influenced. The local driver turns a key into a path, and
 * `../../etc/passwd` must not become one.
 */
export function isSafeKey(key: string): boolean {
  if (key.length === 0 || key.length > 1024) return false;
  if (key.startsWith("/") || key.includes("\\")) return false;
  if (key.includes("\0")) return false;
  return !key.split("/").some((part) => part === "." || part === ".." || part === "");
}

/** Files on disk. The default when no object storage is configured. */
export function createLocalStore(root: string): ObjectStore {
  const pathFor = (key: string): string => {
    if (!isSafeKey(key)) throw new Error(`Unsafe object key: ${key}`);
    const full = resolve(root, key);
    // resolve() collapses any traversal the check above somehow allowed; this
    // is the assertion that it stayed inside.
    if (full !== resolve(root) && !full.startsWith(resolve(root) + sep)) {
      throw new Error(`Object key escapes the store: ${key}`);
    }
    return full;
  };

  return {
    kind: "local",

    async put(key, filePath) {
      const destination = pathFor(key);
      await mkdir(dirname(destination), { recursive: true });
      await Bun.write(destination, Bun.file(filePath));
    },

    async get(key) {
      const file = Bun.file(pathFor(key));
      if (!(await file.exists())) return undefined;
      return file.stream();
    },

    async head(key) {
      try {
        const info = await stat(pathFor(key));
        if (!info.isFile()) return undefined;
        return { key, size: info.size, updatedAt: info.mtime };
      } catch {
        return undefined;
      }
    },

    async list(prefix) {
      const base = pathFor(prefix.replace(/\/+$/, ""));
      let names: string[];
      try {
        names = await readdir(base);
      } catch {
        return [];
      }

      const found: StoredObject[] = [];
      for (const name of names) {
        const info = await stat(join(base, name)).catch(() => undefined);
        if (!info?.isFile()) continue;
        found.push({
          key: `${prefix.replace(/\/+$/, "")}/${name}`,
          size: info.size,
          updatedAt: info.mtime,
        });
      }
      return found;
    },

    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
  };
}

export type S3Config = {
  endpoint?: string;
  region?: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and most self-hosted gateways address buckets by path. */
  forcePathStyle?: boolean;
};

/**
 * Object storage, over Bun's own S3 client.
 *
 * Bun speaks S3 natively, so this needs no AWS SDK — which matters for an
 * image that also carries a browser.
 */
export function createS3Store(config: S3Config): ObjectStore {
  const client = new Bun.S3Client({
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    bucket: config.bucket,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    ...(config.region ? { region: config.region } : {}),
    ...(config.forcePathStyle === false ? {} : { virtualHostedStyle: false }),
  });

  const checked = (key: string): string => {
    if (!isSafeKey(key)) throw new Error(`Unsafe object key: ${key}`);
    return key;
  };

  return {
    kind: "s3",

    async put(key, filePath, contentType) {
      await client.write(checked(key), Bun.file(filePath), {
        ...(contentType ? { type: contentType } : {}),
      });
    },

    async get(key) {
      const object = client.file(checked(key));
      if (!(await object.exists())) return undefined;
      return object.stream();
    },

    async head(key) {
      try {
        const info = await client.stat(checked(key));
        return { key, size: info.size ?? 0, updatedAt: info.lastModified ?? new Date() };
      } catch {
        return undefined;
      }
    },

    async list(prefix) {
      const response = await client.list({ prefix });
      return (response.contents ?? []).map((item) => ({
        key: item.key,
        size: item.size ?? 0,
        updatedAt: item.lastModified ? new Date(item.lastModified) : new Date(),
      }));
    },

    async delete(key) {
      await client.delete(checked(key));
    },
  };
}
