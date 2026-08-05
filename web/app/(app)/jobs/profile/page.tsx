import { desc, eq } from "drizzle-orm";
import { decryptSecret, decryptStructured } from "@browserpilot/core";
import { jobCandidateProfiles, jobDocuments } from "@browserpilot/db";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { deleteCandidateDocument, deleteCandidateProfile, saveCandidateProfile, setDefaultResume, uploadResume } from "../actions";

export default async function ProfilePage() {
  const user = await requirePermission("job.apply");
  const [stored] = await db().select().from(jobCandidateProfiles).where(eq(jobCandidateProfiles.userId, user.id)).limit(1);
  const key = process.env.BP_MASTER_KEY ?? "";
  const profile = stored ? decryptStructured<Record<string, unknown>>(stored.profileEncrypted, key) : {};
  const applicationEmail = stored ? decryptSecret(stored.applicationEmailEncrypted, key) : user.email;
  const notificationEmail = stored ? decryptSecret(stored.notificationEmailEncrypted, key) : user.email;
  const documents = await db().select().from(jobDocuments).where(eq(jobDocuments.userId, user.id)).orderBy(desc(jobDocuments.createdAt));
  const text = (name: string) => typeof profile[name] === "string" ? String(profile[name]) : "";
  return <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
    <Card><CardHeader><CardTitle className="text-base">Candidate profile</CardTitle></CardHeader><CardContent>
      <form action={saveCandidateProfile} className="grid gap-4 sm:grid-cols-2">
        {[["fullName","Full name"],["phone","Phone"],["applicationEmail","Application email"],["notificationEmail","Notification email"],["address","Address"],["city","City"],["region","State / region"],["postalCode","Postal code"],["country","Country"],["linkedin","LinkedIn"],["github","GitHub"],["portfolio","Portfolio"],["workAuthorization","Work authorization"],["sponsorship","Sponsorship"],["locationPreferences","Preferred locations"],["salaryPreference","Salary preference"],["availability","Availability"],["school","Current school"],["degree","Current degree"],["discipline","Current discipline / major"],["educationStartYear","Education start year"],["educationEndYear","Education end year"]].map(([name,label]) =>
          <label key={name} className="grid gap-1 text-sm">{label}<Input name={name} required={["fullName", "phone", "applicationEmail", "notificationEmail", "city", "country"].includes(name)} defaultValue={name === "applicationEmail" ? applicationEmail : name === "notificationEmail" ? notificationEmail : name === "locationPreferences" && Array.isArray(profile.locationPreferences) ? profile.locationPreferences.join(", ") : text(name)} /></label>)}
        <label className="flex items-center gap-2 text-sm sm:col-span-2"><Checkbox name="relocation" defaultChecked={profile.relocation === true} /> Open to relocation</label>
        <label className="grid gap-1 text-sm sm:col-span-2">Professional summary<Textarea name="summary" rows={4} defaultValue={text("summary")} /></label>
        <label className="grid gap-1 text-sm sm:col-span-2">Employment history<Textarea name="employmentHistory" rows={5} defaultValue={text("employmentHistory")} /></label>
        <label className="grid gap-1 text-sm sm:col-span-2">Education<Textarea name="education" rows={4} defaultValue={text("education")} /></label>
        <label className="grid gap-1 text-sm sm:col-span-2">Skills<Textarea name="skills" rows={4} defaultValue={text("skills")} /></label>
        <label className="grid gap-1 text-sm sm:col-span-2">Selected projects<Textarea name="projects" rows={5} defaultValue={text("projects")} /></label>
        <label className="grid gap-1 text-sm sm:col-span-2">Certifications<Textarea name="certifications" rows={3} defaultValue={text("certifications")} /></label>
        <div className="sm:col-span-2"><Button type="submit">Save encrypted profile</Button></div>
      </form>
      {stored ? <form action={deleteCandidateProfile} className="mt-4"><Button type="submit" variant="ghost">Delete private profile</Button></form> : null}
    </CardContent></Card>
    <div className="space-y-6">
      <Card><CardHeader><CardTitle className="text-base">Upload résumé</CardTitle></CardHeader><CardContent>
        <form action={uploadResume} className="grid gap-3">
          <Input name="name" placeholder="Version name" /><Input name="file" type="file" accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" required />
          <label className="flex items-center gap-2 text-sm"><Checkbox name="isDefault" /> Make default</label><Button type="submit">Upload encrypted file</Button>
        </form>
      </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Documents</CardTitle></CardHeader><CardContent className="space-y-3">
        {documents.map((document) => <div key={document.id} className="flex items-center justify-between gap-3 text-sm"><div><a className="font-medium underline-offset-4 hover:underline" href={`/api/jobs/documents/${document.id}`}>{document.name}</a><p className="text-muted-foreground text-xs">{document.kind.replace("_", " ")} · {Math.ceil(document.sizeBytes / 1024)} KB</p></div><div className="flex items-center gap-2">{document.kind === "resume" && !document.isDefault ? <form action={setDefaultResume.bind(null, document.id)}><Button type="submit" size="sm" variant="outline">Set default</Button></form> : document.isDefault ? <span className="text-xs">Default</span> : null}<form action={deleteCandidateDocument.bind(null, document.id)}><Button type="submit" size="sm" variant="ghost">Delete</Button></form></div></div>)}
      </CardContent></Card>
    </div>
  </div>;
}
