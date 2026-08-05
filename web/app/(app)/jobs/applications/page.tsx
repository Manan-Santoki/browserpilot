import { and, desc, eq, ilike, isNull, type SQL } from "drizzle-orm";
import { jobApplications, jobCandidateProfiles, jobConsents, jobDocuments, jobQuestions } from "@browserpilot/db";
import { JOB_CONSENT_VERSION } from "@browserpilot/core";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { acceptJobConsent, answerPendingQuestion, cancelApplication, deleteApplication, reapplyApplication, retryApplication, submitJobLinks } from "../actions";

const FILTERABLE_STATUSES = ["queued", "running", "needs_attention", "applied", "not_applied", "failed", "cancelled"] as const;

export default async function ApplicationsPage({ searchParams }: { searchParams: Promise<{ q?: string; status?: string }> }) {
  const user = await requirePermission("job.apply");
  const params = await searchParams;
  const query = params.q?.trim() ?? "";
  const status = FILTERABLE_STATUSES.find((candidate) => candidate === params.status) ?? "";
  const resumes = await db().select().from(jobDocuments)
    .where(and(eq(jobDocuments.userId, user.id), eq(jobDocuments.kind, "resume")))
    .orderBy(desc(jobDocuments.isDefault), desc(jobDocuments.createdAt));
  const filters: SQL[] = [eq(jobApplications.userId, user.id)];
  if (query) filters.push(ilike(jobApplications.sourceUrl, `%${query}%`));
  if (status) filters.push(eq(jobApplications.status, status));
  const applications = await db().select().from(jobApplications)
    .where(and(...filters))
    .orderBy(desc(jobApplications.createdAt)).limit(200);
  const questions = await db().select().from(jobQuestions)
    .where(and(eq(jobQuestions.userId, user.id), eq(jobQuestions.status, "pending")))
    .orderBy(desc(jobQuestions.createdAt));
  const [consent] = await db().select({ id: jobConsents.id }).from(jobConsents)
    .where(and(eq(jobConsents.userId, user.id), eq(jobConsents.version, JOB_CONSENT_VERSION), isNull(jobConsents.revokedAt))).limit(1);
  const [candidateProfile] = await db().select({ id: jobCandidateProfiles.userId }).from(jobCandidateProfiles)
    .where(eq(jobCandidateProfiles.userId, user.id)).limit(1);

  return (
    <div className="space-y-6">
      {!consent ? (
        <Card className="border-amber-500/40">
          <CardHeader><CardTitle className="text-base">One-time application consent</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>I authorize BrowserPilot to submit truthful saved answers, routine attestations, and my electronic signature. Unusual legal language will still pause for review.</p>
            <p className="text-muted-foreground">I remain responsible for each portal&apos;s terms and anti-automation policies. BrowserPilot never bypasses CAPTCHA, MFA, or device confirmation.</p>
            <form action={acceptJobConsent}><Button type="submit">Accept and enable job mode</Button></form>
          </CardContent>
        </Card>
      ) : null}

      {!candidateProfile ? (
        <Card className="border-amber-500/40">
          <CardContent className="flex flex-col gap-3 py-4 text-sm md:flex-row md:items-center md:justify-between">
            <div><p className="font-medium">Complete your candidate profile first</p><p className="text-muted-foreground">Full name, phone, and application email are required before a browser can start.</p></div>
            <a href="/jobs/profile" className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-center text-sm font-medium">Open Profile &amp; documents</a>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle className="text-base">Start applications</CardTitle></CardHeader>
        <CardContent>
          <form action={submitJobLinks} className="grid gap-4">
            <label className="grid gap-1.5 text-sm">Public HTTPS job links, one per line
              <Textarea name="links" rows={6} required placeholder="https://boards.greenhouse.io/company/jobs/123" />
            </label>
            <label className="grid gap-1.5 text-sm">Résumé
              <select name="resumeId" required defaultValue={resumes.find((r) => r.isDefault)?.id ?? ""} className="border-input bg-background h-9 rounded-md border px-3 text-sm">
                <option value="" disabled>Select a résumé</option>
                {resumes.map((resume) => <option key={resume.id} value={resume.id}>{resume.name}{resume.isDefault ? " · default" : ""}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-sm"><Checkbox name="reapply" /> Explicitly reapply when a finished duplicate exists</label>
            <div><Button type="submit" disabled={!consent || !candidateProfile || resumes.length === 0}>Queue applications</Button></div>
          </form>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-medium">History</h2>
        <form className="flex flex-wrap gap-2">
          <Input name="q" defaultValue={query} placeholder="Search job links" />
          <select name="status" defaultValue={status} aria-label="Filter by status" className="border-input bg-background h-9 rounded-md border px-3 text-sm">
            <option value="">All statuses</option>
            {FILTERABLE_STATUSES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}
          </select>
          <Button type="submit" variant="outline">Filter</Button>
        </form>
      </div>
      {questions.length ? <div className="space-y-3"><h2 className="text-lg font-medium">Answers needed</h2>{questions.map((question) => <Card key={question.id} className="border-amber-500/40"><CardContent className="py-4"><form action={answerPendingQuestion.bind(null, question.id)} className="grid gap-3"><p className="text-sm font-medium">{question.questionLabel}</p>{question.answerType === "boolean" ? <select name="answer" className="border-input bg-background h-9 rounded-md border px-3"><option value="true">Yes</option><option value="false">No</option></select> : question.answerType === "single_choice" ? <select name="answer" className="border-input bg-background h-9 rounded-md border px-3">{(question.options ?? []).map((option) => <option key={option}>{option}</option>)}</select> : question.answerType === "multi_choice" ? <div className="grid gap-2">{(question.options ?? []).map((option) => <label key={option} className="flex items-center gap-2 text-sm"><Checkbox name="answer" value={option} />{option}</label>)}</div> : <Input name="answer" type={question.answerType === "number" ? "number" : question.answerType === "date" ? "date" : "text"} required />}<div><Button type="submit" size="sm">Save encrypted answer and continue</Button></div></form></CardContent></Card>)}</div> : null}
      <div className="grid gap-3">
        {applications.length === 0 ? <p className="text-muted-foreground text-sm">No applications yet.</p> : applications.map((application) => (
          <Card key={application.id}>
            <CardContent className="flex flex-col gap-3 py-4 md:flex-row md:items-center md:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2"><Badge variant="outline">{application.status.replaceAll("_", " ")}</Badge><span className="text-muted-foreground text-xs uppercase">{application.atsKind}</span></div>
                <p className="mt-2 truncate text-sm font-medium">{application.roleTitle ?? application.sourceUrl}</p>
                <p className="text-muted-foreground mt-1 text-xs">{application.statusDetail ?? application.company ?? "Waiting for discovery"}</p>
              </div>
              <div className="flex gap-2">
                {application.attentionKind === "needs_takeover" ? <a className="bg-primary text-primary-foreground rounded-md px-3 py-1.5 text-sm font-medium" href={`/jobs/applications/${application.id}/takeover`}>Take over</a> : null}
                {(application.status === "failed" || (application.status === "needs_attention" && !["needs_answer", "needs_takeover"].includes(application.attentionKind ?? ""))) ? <form action={retryApplication.bind(null, application.id)}><Button type="submit" size="sm" variant="outline">Retry</Button></form> : null}
                {["queued", "running", "needs_attention"].includes(application.status) ? <form action={cancelApplication.bind(null, application.id)}><Button type="submit" size="sm" variant="ghost">Cancel</Button></form> : null}
                {["applied", "not_applied", "failed", "cancelled"].includes(application.status) && application.resumeDocumentId ? <form action={reapplyApplication.bind(null, application.id)}><Button type="submit" size="sm" variant="outline">Reapply</Button></form> : null}
                {["applied", "not_applied", "failed", "cancelled"].includes(application.status) ? <form action={deleteApplication.bind(null, application.id)}><Button type="submit" size="sm" variant="ghost">Delete history</Button></form> : null}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
