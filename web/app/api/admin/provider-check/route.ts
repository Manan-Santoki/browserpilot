import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { runtimeProviderStatus } from "@/lib/runtime";

/**
 * Ask the runtime whether one model actually answers.
 *
 * A route rather than a server action because the Models page tests models one
 * at a time without navigating: the answer belongs next to the row that asked
 * for it, and re-rendering the whole form would lose the edits in progress.
 *
 * It probes what is *saved*, not what is on screen — so an unsaved change reads
 * as "not yet", which is the truth.
 */
export async function GET(request: Request) {
  const admin = await requireAdmin();

  const model = new URL(request.url).searchParams.get("model")?.trim();
  if (!model) return NextResponse.json({ error: "A model is required" }, { status: 400 });

  const status = await runtimeProviderStatus(admin, model);
  if (!status.ok) {
    return NextResponse.json({ reachable: false, error: status.error }, { status: 200 });
  }

  return NextResponse.json({
    model: status.data.model,
    reachable: Boolean(status.data.reachable),
    rateLimited: Boolean(status.data.rateLimited),
    latencyMs: status.data.latencyMs,
    error: status.data.error,
  });
}
