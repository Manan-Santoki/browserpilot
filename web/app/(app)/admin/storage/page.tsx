import { settings } from "@browserpilot/db";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { runtimeStorageStatus } from "@/lib/runtime";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StorageForm } from "./form";

export default async function StoragePage() {
  const admin = await requireAdmin();
  const status = await runtimeStorageStatus(admin);

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

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Right now</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {!status.ok ? (
            <p className="text-destructive">
              The browser service did not answer, so this cannot be confirmed: {status.error}
            </p>
          ) : status.data.driver === "local" ? (
            <p className="text-muted-foreground">
              Files are being kept on the server&apos;s own disk. They are lost when it is
              redeployed.
            </p>
          ) : status.data.reachable ? (
            <p>
              <span className="lamp lamp-idle" aria-hidden /> Files are going to{" "}
              <span className="font-mono text-xs">{status.data.bucket}</span>
              {status.data.endpoint ? (
                <>
                  {" at "}
                  <span className="font-mono text-xs">{status.data.endpoint}</span>
                </>
              ) : null}
              . Checked by writing an object and reading it back.
            </p>
          ) : (
            <p className="text-destructive">
              <span className="lamp lamp-waiting" aria-hidden /> The bucket{" "}
              <span className="font-mono text-xs">{status.data.bucket}</span> is configured but
              could not be written to{status.data.error ? `: ${status.data.error}` : "."} Downloads
              will fail until this is fixed.
            </p>
          )}
        </CardContent>
      </Card>

      <StorageForm current={current} />
    </div>
  );
}
