import { inArray } from "drizzle-orm";
import { robotSessions, settings } from "@browserpilot/db";
import { count } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { availableModels, modelsIncluding } from "@/lib/models";
import { AdminHeader, AdminStatus, type StatusItem } from "../shell";
import { SettingsForm } from "./form";

const LIVE = ["starting", "idle", "working", "awaiting_approval"] as const;

/**
 * What one headless Chromium costs, measured on this deployment. Used only to
 * turn the global cap into the number that actually constrains it — memory.
 */
const MB_PER_BROWSER_LOW = 200;
const MB_PER_BROWSER_HIGH = 400;

const DEFAULTS = {
  perUserSessionLimit: 3,
  globalSessionLimit: 8,
  idleTimeoutMs: 600_000,
  hardCapMs: 3_600_000,
};

function humanDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} m`;
}

export default async function SettingsPage() {
  await requireAdmin();

  const rows = await db().select().from(settings);
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  // Before an admin has chosen, the head of the catalogue is what the runtime
  // would fall back to — so the form shows the same answer the agent uses.
  const catalogue = await availableModels();
  const defaultModel = String(stored.defaultModel ?? catalogue[0]?.value ?? "");

  const current = {
    perUserSessionLimit: Number(stored.perUserSessionLimit ?? DEFAULTS.perUserSessionLimit),
    globalSessionLimit: Number(stored.globalSessionLimit ?? DEFAULTS.globalSessionLimit),
    idleTimeoutMs: Number(stored.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs),
    hardCapMs: Number(stored.hardCapMs ?? DEFAULTS.hardCapMs),
    defaultModel,
  };

  const [live] = await db()
    .select({ n: count() })
    .from(robotSessions)
    .where(inArray(robotSessions.status, [...LIVE]));
  const running = live?.n ?? 0;

  // The rail says what the form cannot: how much of the cap is actually in
  // use. Restating the numbers from the fields below it would be decoration —
  // the question an admin arrives with is whether there is room, and what
  // raising the ceiling would cost the machine.
  const headroom = current.globalSessionLimit - running;
  const statusItems: StatusItem[] = [
    {
      label: "In use now",
      value: `${running} of ${current.globalSessionLimit}`,
      tone: headroom <= 0 ? "warn" : running > 0 ? "ok" : "idle",
      hint:
        headroom <= 0
          ? "full — the next session is refused"
          : `${headroom} more can start`,
    },
    {
      label: "Memory at the cap",
      value: `${MB_PER_BROWSER_LOW * current.globalSessionLimit}–${MB_PER_BROWSER_HIGH * current.globalSessionLimit} MB`,
      tone: "idle",
      hint: "if every browser were running",
    },
  ];

  return (
    <>
      <AdminHeader
        title="Limits"
        description="How many browsers the server runs, when it stops them, and which model new sessions default to."
      />

      <AdminStatus items={statusItems} />

      <SettingsForm current={current} models={await modelsIncluding(defaultModel)} />
    </>
  );
}
