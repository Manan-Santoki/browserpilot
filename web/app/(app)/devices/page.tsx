import { desc, eq } from "drizzle-orm";
import { remoteDevices } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { revokeDevice } from "./actions";
import { ConfirmAction } from "@/components/confirm-action";
import { PairingPanel } from "./pairing-panel";

export default async function DevicesPage() {
  const user = await requireUser();

  const devices = await db()
    .select({
      id: remoteDevices.id,
      name: remoteDevices.name,
      createdAt: remoteDevices.createdAt,
      lastSeenAt: remoteDevices.lastSeenAt,
      revokedAt: remoteDevices.revokedAt,
    })
    .from(remoteDevices)
    .where(eq(remoteDevices.userId, user.id))
    .orderBy(desc(remoteDevices.createdAt));

  const active = devices.filter((d) => !d.revokedAt);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Devices</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Pair a phone to reach these same sessions from the mobile app.
        </p>
      </div>

      <PairingPanel />

      <section>
        <h2 className="text-base font-medium">Paired devices</h2>
        {active.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No devices paired yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-border rounded-lg border">
            {active.map((device) => (
              <li key={device.id} className="flex items-center gap-4 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{device.name}</p>
                  <p className="text-muted-foreground">
                    paired {new Date(device.createdAt).toLocaleDateString()}
                    {device.lastSeenAt
                      ? ` · last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                      : ""}
                  </p>
                </div>
                <ConfirmAction
                  action={revokeDevice}
                  fields={{ deviceId: device.id }}
                  label="Revoke"
                  title={`Revoke ${device.name}?`}
                  description="That phone is signed out immediately and cannot reach your sessions again until you pair it a second time."
                  confirmLabel="Revoke it"
                  destructive
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
