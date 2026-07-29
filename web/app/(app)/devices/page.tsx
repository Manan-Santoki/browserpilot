import { desc, eq } from "drizzle-orm";
import { remoteDevices } from "@browserpilot/db";
import { requireUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { revokeDevice } from "./actions";
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
    <div className="space-y-10">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Devices</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Pair a phone to reach these same sessions from the mobile app.
        </p>
      </div>

      <PairingPanel />

      <section>
        <h2 className="text-base font-medium">Paired devices</h2>
        {active.length === 0 ? (
          <p className="mt-3 text-sm text-neutral-500 dark:text-neutral-400">
            No devices paired yet.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-neutral-200 rounded-lg border border-neutral-200 dark:divide-neutral-800 dark:border-neutral-800">
            {active.map((device) => (
              <li key={device.id} className="flex items-center gap-4 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">{device.name}</p>
                  <p className="text-neutral-500 dark:text-neutral-400">
                    paired {new Date(device.createdAt).toLocaleDateString()}
                    {device.lastSeenAt
                      ? ` · last seen ${new Date(device.lastSeenAt).toLocaleString()}`
                      : ""}
                  </p>
                </div>
                <form action={revokeDevice}>
                  <input type="hidden" name="deviceId" value={device.id} />
                  <button
                    type="submit"
                    className="text-sm text-neutral-500 underline-offset-4 hover:underline dark:text-neutral-400"
                  >
                    Revoke
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
