import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { robotSessions } from "@browserpilot/db";
import { db } from "@/lib/db";
import { ticketFor, runtimeHttpUrl } from "@/lib/runtime";
import { isViewable } from "@browserpilot/core";
import { getCurrentUser } from "@/lib/session";

/**
 * Stream a downloaded file from the runtime.
 *
 * The runtime requires a per-session ticket, and a browser following a plain
 * link carries no ticket — so a direct runtime URL always failed. The console
 * holds the session cookie, mints the ticket server-side, and proxies the
 * bytes, which also keeps the runtime off the public link surface.
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string; name: string }> },
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const { id, name } = await params;

  const [session] = await db()
    .select({ userId: robotSessions.userId })
    .from(robotSessions)
    .where(eq(robotSessions.id, id))
    .limit(1);

  if (!session) return NextResponse.json({ error: "No such session" }, { status: 404 });
  if (user.role !== "ADMIN" && session.userId !== user.id) {
    return NextResponse.json({ error: "Not your session" }, { status: 403 });
  }

  const ticket = await ticketFor(user, id);
  const upstream = await fetch(
    `${runtimeHttpUrl()}/api/sessions/${id}/files/${encodeURIComponent(name)}`,
    { headers: { authorization: `Bearer ${ticket}` }, cache: "no-store" },
  ).catch(() => null);

  if (!upstream) {
    return NextResponse.json({ error: "The browser service is unreachable" }, { status: 503 });
  }
  if (!upstream.ok) {
    // A session that has ended takes its downloads with it — say so plainly.
    return NextResponse.json(
      {
        error:
          upstream.status === 404
            ? "That file is no longer available."
            : "Could not fetch that file.",
      },
      { status: upstream.status },
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";

  // Anything the console can show — a purchase order, a screenshot — is served
  // inline so the viewer can render it in place. ?download=1 is how the Save
  // control asks for the same file as a file.
  const wantsDownload = new URL(req.url).searchParams.get("download") === "1";
  const disposition = !wantsDownload && isViewable(name) ? "inline" : "attachment";

  return new NextResponse(upstream.body, {
    headers: {
      "content-type": contentType,
      "content-disposition": `${disposition}; filename="${name.replace(/"/g, "")}"`,
      "cache-control": "private, max-age=300",
    },
  });
}
