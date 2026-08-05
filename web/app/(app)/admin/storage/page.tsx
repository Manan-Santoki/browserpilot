import { settings } from "@browserpilot/db";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { runtimeStorageStatus } from "@/lib/runtime";
import { AdminHeader, AdminStatus, type StatusItem } from "../shell";
import { StorageForm } from "./form";

export default async function StoragePage() {
  const admin = await requirePermission("storage.manage");
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

  // How "Right now" reads, proven by writing an object and reading it back.
  let statusItems: StatusItem[];
  if (!status.ok) {
    statusItems = [
      {
        label: "Storage",
        value: "Unreachable",
        tone: "bad",
        hint: "The browser service did not answer.",
      },
    ];
  } else if (status.data.driver === "local") {
    statusItems = [
      {
        label: "Where files go",
        value: "This server's disk",
        tone: "warn",
        hint: "Lost when it is redeployed.",
      },
    ];
  } else {
    statusItems = [
      {
        label: "Where files go",
        value: status.data.bucket ?? "—",
        tone: status.data.reachable ? "ok" : "bad",
        hint: status.data.error ?? (status.data.endpoint ? `at ${status.data.endpoint}` : "Amazon S3"),
      },
      {
        label: "Write test",
        value: status.data.reachable ? "passed" : "failed",
        tone: status.data.reachable ? "ok" : "bad",
        hint: status.data.reachable
          ? "wrote an object and read it back"
          : "downloads will fail until this is fixed",
      },
    ];
  }

  return (
    <>
      <AdminHeader
        title="Storage"
        description="Where the files the robot downloads are kept. This deployment ships with its own bucket; point it at your own if you would rather the files lived somewhere you control."
      />

      <AdminStatus items={statusItems} />

      <StorageForm current={current} />
    </>
  );
}
