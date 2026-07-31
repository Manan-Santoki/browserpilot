import { settings } from "@browserpilot/db";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { availableModels, modelsIncluding } from "@/lib/models";
import { SettingsForm } from "./form";

const DEFAULTS = {
  perUserSessionLimit: 3,
  globalSessionLimit: 8,
  idleTimeoutMs: 600_000,
  hardCapMs: 3_600_000,
};

export default async function SettingsPage() {
  await requireAdmin();

  const rows = await db().select().from(settings);
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  // Before an admin has chosen, the head of the catalogue is what the runtime
  // would fall back to — so the form shows the same answer the agent uses.
  const catalogue = availableModels();
  const defaultModel = String(stored.defaultModel ?? catalogue[0]?.value ?? "");

  const current = {
    perUserSessionLimit: Number(stored.perUserSessionLimit ?? DEFAULTS.perUserSessionLimit),
    globalSessionLimit: Number(stored.globalSessionLimit ?? DEFAULTS.globalSessionLimit),
    idleTimeoutMs: Number(stored.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs),
    hardCapMs: Number(stored.hardCapMs ?? DEFAULTS.hardCapMs),
    defaultModel,
  };

  return (
    <div className="mx-auto w-full max-w-6xl max-w-lg space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Limits</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Each running browser costs roughly 200–400 MB of memory, so the global limit is really a
          statement about this server&apos;s RAM. Raise it only as far as the machine allows.
        </p>
      </div>

      <SettingsForm current={current} models={modelsIncluding(defaultModel)} />
    </div>
  );
}
