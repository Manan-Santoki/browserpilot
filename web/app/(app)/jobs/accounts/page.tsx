import { and, desc, eq } from "drizzle-orm";
import { jobConnections, jobPortalAccounts } from "@browserpilot/db";
import { db } from "@/lib/db";
import { requirePermission } from "@/lib/auth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CredentialReveal } from "./reveal";
import { deletePortalCredential, disconnectGmail } from "../actions";

const mask = (value: string) => value.includes("@") ? `${value.slice(0, 2)}•••@${value.split("@")[1]}` : `${value.slice(0, 2)}••••`;

export default async function AccountsPage() {
  const user = await requirePermission("job.apply");
  const [gmail] = await db().select({ email: jobConnections.accountEmail, state: jobConnections.state, scope: jobConnections.scope, updatedAt: jobConnections.updatedAt })
    .from(jobConnections).where(and(eq(jobConnections.userId, user.id), eq(jobConnections.kind, "gmail"))).limit(1);
  const accounts = await db().select().from(jobPortalAccounts).where(eq(jobPortalAccounts.userId, user.id)).orderBy(desc(jobPortalAccounts.lastUsedAt));
  return <div className="space-y-6">
    <Card><CardHeader><CardTitle className="text-base">Gmail verification & notifications</CardTitle></CardHeader><CardContent className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
      <div>{gmail ? <><p className="text-sm font-medium">{mask(gmail.email)}</p><p className="text-muted-foreground text-xs">{gmail.state} · minimum Gmail read/send scopes</p></> : <><p className="text-sm">No Gmail connection</p><p className="text-muted-foreground text-xs">Offline OAuth is used; message bodies are never stored or sent to a model.</p></>}</div>
      {gmail ? <form action={disconnectGmail}><Button type="submit" variant="outline">Disconnect Gmail</Button></form> : <a href="/api/jobs/gmail/connect" className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium">Connect Gmail</a>}
    </CardContent></Card>
    <Card><CardHeader><CardTitle className="text-base">Portal accounts</CardTitle></CardHeader><CardContent className="space-y-4">
      {accounts.length === 0 ? <p className="text-muted-foreground text-sm">No portal accounts have been created.</p> : accounts.map((account) => <div key={account.id} className="flex flex-col gap-3 border-b pb-4 last:border-0 md:flex-row md:items-center md:justify-between"><div><p className="text-sm font-medium">{account.portalLabel}</p><p className="text-muted-foreground text-xs">{mask(account.username)} · {account.status} · {account.verificationStatus}</p></div><div className="flex gap-2"><CredentialReveal accountId={account.id} /><form action={deletePortalCredential.bind(null, account.id)}><Button type="submit" size="sm" variant="ghost">Delete credential</Button></form></div></div>)}
    </CardContent></Card>
  </div>;
}
