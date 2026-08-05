import { and, desc, eq, inArray } from "drizzle-orm";
import { notFound } from "next/navigation";
import { jobApplications, robotSessions } from "@browserpilot/db";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { RemoteBrowser } from "@/app/(app)/sites/[id]/sign-in/[sessionId]/remote-browser";
import { completeManualTakeover } from "../../../actions";

export default async function JobTakeoverPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requirePermission("job.apply");
  const { id } = await params;
  const [application] = await db().select({ id: jobApplications.id, detail: jobApplications.statusDetail })
    .from(jobApplications)
    .where(and(eq(jobApplications.id, id), eq(jobApplications.userId, user.id), eq(jobApplications.attentionKind, "needs_takeover"))).limit(1);
  if (!application) notFound();
  const [session] = await db().select({ id: robotSessions.id }).from(robotSessions)
    .where(and(eq(robotSessions.jobApplicationId, application.id), inArray(robotSessions.status, ["starting", "idle", "working", "awaiting_approval"])))
    .orderBy(desc(robotSessions.startedAt)).limit(1);
  if (!session) notFound();
  return (
    <div className="space-y-4">
      <div><h2 className="text-lg font-medium">Manual takeover</h2><p className="text-muted-foreground text-sm">{application.detail}</p></div>
      <Card><CardContent className="p-4"><RemoteBrowser sessionId={session.id} /></CardContent><CardFooter className="border-t py-3"><form action={completeManualTakeover.bind(null, application.id)}><Button type="submit">Return control to the application agent</Button></form></CardFooter></Card>
    </div>
  );
}
