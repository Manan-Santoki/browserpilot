import { settings } from "@browserpilot/db";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { StorageForm } from "./form";

export default async function StoragePage() {
  await requireAdmin();

  const rows = await db().select().from(settings);
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  // Everything except the secret, which is sealed and never comes back out.
  const current = {
    driver: String(stored.storageDriver ?? "s3") === "local" ? "local" : "s3",
    endpoint: String(stored.s3Endpoint ?? ""),
    region: String(stored.s3Region ?? ""),
    bucket: String(stored.s3Bucket ?? ""),
    accessKeyId: String(stored.s3AccessKeyId ?? ""),
    forcePathStyle: stored.s3ForcePathStyle !== false,
    hasSecret: typeof stored.s3SecretAccessKey === "string",
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Storage</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Where the files the robot downloads are kept. This deployment ships with its own bucket;
          point it at your own if you would rather the files lived somewhere you control.
        </p>
      </div>

      <StorageForm current={current} />
    </div>
  );
}
