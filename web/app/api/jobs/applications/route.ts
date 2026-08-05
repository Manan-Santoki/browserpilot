import { and, desc, eq, ilike, inArray } from "drizzle-orm";
import { jobApplications } from "@browserpilot/db";
import { can } from "@/lib/auth";
import { db } from "@/lib/db";
import { submitJobApplications } from "@/lib/job-applications";
import { getCurrentUser } from "@/lib/session";

const STATUSES = ["queued", "running", "needs_attention", "applied", "not_applied", "failed", "cancelled"] as const;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim() ?? "";
  const requested = url.searchParams.getAll("status").filter((status): status is typeof STATUSES[number] => STATUSES.includes(status as typeof STATUSES[number]));
  const applications = await db().select().from(jobApplications).where(and(
    eq(jobApplications.userId, user.id),
    ...(query ? [ilike(jobApplications.sourceUrl, `%${query}%`)] : []),
    ...(requested.length ? [inArray(jobApplications.status, requested)] : []),
  )).orderBy(desc(jobApplications.createdAt)).limit(200);
  return Response.json({ applications }, { headers: { "cache-control": "private, no-store" } });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!can(user, "job.apply")) return Response.json({ error: "Forbidden" }, { status: 403 });
  const body = await request.json().catch(() => ({})) as { links?: string[] | string; resumeId?: string; reapply?: boolean };
  const links = Array.isArray(body.links) ? body.links : typeof body.links === "string" ? body.links.split(/\r?\n|,/) : [];
  if (!body.resumeId) return Response.json({ error: "resumeId is required" }, { status: 400 });
  try {
    const applications = await submitJobApplications(user, { links, resumeId: body.resumeId, reapply: body.reapply === true });
    return Response.json({ applications }, { status: 201, headers: { "cache-control": "no-store" } });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
}
