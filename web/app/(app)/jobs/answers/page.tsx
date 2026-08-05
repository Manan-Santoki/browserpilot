import { desc, eq } from "drizzle-orm";
import { jobAnswers } from "@browserpilot/db";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { deleteApplicationAnswer, saveApplicationAnswer } from "../actions";

export default async function AnswersPage() {
  const user = await requirePermission("job.apply");
  const answers = await db().select({ id: jobAnswers.id, label: jobAnswers.questionLabel, category: jobAnswers.category, type: jobAnswers.answerType, updatedAt: jobAnswers.updatedAt })
    .from(jobAnswers).where(eq(jobAnswers.userId, user.id)).orderBy(desc(jobAnswers.updatedAt));
  return <div className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
    <Card><CardHeader><CardTitle className="text-base">Save an application answer</CardTitle></CardHeader><CardContent>
      <form action={saveApplicationAnswer} className="grid gap-3">
        <label className="grid gap-1 text-sm">Question<Input name="question" required /></label>
        <label className="grid gap-1 text-sm">Category<select name="category" className="border-input bg-background h-9 rounded-md border px-3"><option>sponsorship</option><option>authorization</option><option>relocation</option><option>locations</option><option>salary</option><option>availability</option><option>employment</option><option>education</option><option>demographics</option><option>custom</option></select></label>
        <label className="grid gap-1 text-sm">Answer type<select name="answerType" className="border-input bg-background h-9 rounded-md border px-3"><option value="text">Text</option><option value="boolean">Boolean</option><option value="number">Number</option><option value="date">Date</option><option value="single_choice">Single choice</option><option value="multi_choice">Multiple choice</option></select></label>
        <label className="grid gap-1 text-sm">Exact options, one per line<Textarea name="options" rows={3} /></label>
        <label className="grid gap-1 text-sm">Answer<Textarea name="answer" rows={3} required /></label>
        <label className="flex items-center gap-2 text-sm"><Checkbox name="isSensitive" /> Voluntary demographic / sensitive</label>
        <Button type="submit">Encrypt and save</Button>
      </form>
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">Reusable answers</CardTitle></CardHeader><CardContent className="space-y-3">
      <p className="text-muted-foreground text-xs">Values stay encrypted. Custom answers are reused only for the same normalized question and compatible options.</p>
      {answers.map((answer) => <div key={answer.id} className="flex items-start justify-between gap-3 rounded-md border p-3"><div><p className="text-sm font-medium">{answer.label}</p><p className="text-muted-foreground mt-1 text-xs">{answer.category} · {answer.type.replace("_", " ")} · saved {answer.updatedAt.toLocaleDateString()}</p></div><form action={deleteApplicationAnswer.bind(null, answer.id)}><Button type="submit" size="sm" variant="ghost">Delete</Button></form></div>)}
    </CardContent></Card>
  </div>;
}
