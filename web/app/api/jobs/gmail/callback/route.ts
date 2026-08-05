import { decryptStructured, encryptSecret } from "@browserpilot/core";
import { jobConnections } from "@browserpilot/db";
import { audit } from "@/lib/audit";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/session";

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return new Response("Authentication required", { status: 401 });
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const key = process.env.BP_MASTER_KEY;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const webUrl = process.env.BP_WEB_URL;
  if (!code || !state || !key || !clientId || !clientSecret || !webUrl) return new Response("Invalid OAuth callback", { status: 400 });
  let decoded: { userId: string; expiresAt: number };
  try { decoded = decryptStructured(state, key); } catch { return new Response("Invalid OAuth state", { status: 400 }); }
  if (decoded.userId !== user.id || decoded.expiresAt < Date.now()) return new Response("Expired OAuth state", { status: 400 });
  const redirectUri = new URL("/api/jobs/gmail/callback", webUrl).toString();
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
    cache: "no-store",
  });
  const tokens = await tokenResponse.json() as { access_token?: string; refresh_token?: string; scope?: string; expires_in?: number; error_description?: string };
  if (!tokenResponse.ok || !tokens.access_token || !tokens.refresh_token) return new Response(tokens.error_description ?? "Google did not return offline access", { status: 400 });
  const granted = new Set((tokens.scope ?? "").split(/\s+/).filter(Boolean));
  const required = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.send",
  ];
  if (required.some((scope) => !granted.has(scope))) {
    return new Response("Google did not grant the required Gmail read/send scopes", { status: 400 });
  }
  const profileResponse = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", { headers: { authorization: `Bearer ${tokens.access_token}` }, cache: "no-store" });
  const profile = await profileResponse.json() as { emailAddress?: string };
  if (!profileResponse.ok || !profile.emailAddress) return new Response("Could not read the connected Gmail address", { status: 400 });
  await db().insert(jobConnections).values({
    userId: user.id, kind: "gmail", accountEmail: profile.emailAddress,
    refreshTokenEncrypted: encryptSecret(tokens.refresh_token, key), scope: tokens.scope ?? "", state: "active",
    expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : null,
  }).onConflictDoUpdate({
    target: [jobConnections.userId, jobConnections.kind],
    set: { accountEmail: profile.emailAddress, refreshTokenEncrypted: encryptSecret(tokens.refresh_token, key), scope: tokens.scope ?? "", state: "active", revokedAt: null, lastError: null, updatedAt: new Date() },
  });
  await audit({ actorUserId: user.id, action: "job.gmail_connected", targetType: "job_connection", targetId: user.id, metadata: { scopes: (tokens.scope ?? "").split(" ").filter(Boolean) } });
  return Response.redirect(new URL("/jobs/accounts", webUrl));
}
