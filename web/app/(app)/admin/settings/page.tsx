import { settings } from "@browserpilot/db";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { SettingsForm } from "./form";

const DEFAULTS = {
  perUserSessionLimit: 3,
  globalSessionLimit: 8,
  idleTimeoutMs: 600_000,
  hardCapMs: 3_600_000,
  defaultModel: "claude-opus-5",
};

export default async function SettingsPage() {
  await requireAdmin();

  const rows = await db().select().from(settings);
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  const current = {
    perUserSessionLimit: Number(stored.perUserSessionLimit ?? DEFAULTS.perUserSessionLimit),
    globalSessionLimit: Number(stored.globalSessionLimit ?? DEFAULTS.globalSessionLimit),
    idleTimeoutMs: Number(stored.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs),
    hardCapMs: Number(stored.hardCapMs ?? DEFAULTS.hardCapMs),
    defaultModel: String(stored.defaultModel ?? DEFAULTS.defaultModel),
  };

  return (
    <div className="max-w-lg space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Limits</h1>
        <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
          Each running browser costs roughly 200–400 MB of memory, so the global limit is really a
          statement about this server&apos;s RAM. Raise it only as far as the machine allows.
        </p>
      </div>

      <SettingsForm current={current} />
    </div>
  );
}
