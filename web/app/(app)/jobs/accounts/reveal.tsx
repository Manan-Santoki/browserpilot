"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CredentialReveal({ accountId }: { accountId: string }) {
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { if (!secret) return; const timer = setTimeout(() => setSecret(""), 15_000); return () => clearTimeout(timer); }, [secret]);
  async function reveal() {
    setError(""); setSecret("");
    const response = await fetch(`/api/jobs/credentials/${accountId}/reveal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }), cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) setError(String(body.error ?? "Reveal failed")); else { setSecret(String(body.password)); setPassword(""); }
  }
  return <div className="flex flex-wrap items-center gap-2"><Input className="h-8 w-36" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Current password" /><Button type="button" size="sm" variant="outline" onClick={reveal}>Reveal 15s</Button>{secret ? <code className="rounded bg-muted px-2 py-1 text-xs">{secret}</code> : null}{error ? <span className="text-destructive text-xs">{error}</span> : null}</div>;
}
