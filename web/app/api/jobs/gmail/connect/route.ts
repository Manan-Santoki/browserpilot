import { encryptStructured } from "@browserpilot/core";
import { getCurrentUser } from "@/lib/session";

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
];

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return new Response("Authentication required", { status: 401 });
  if (user.role !== "ADMIN" && !user.perms.includes("job.apply")) return new Response("Forbidden", { status: 403 });
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const webUrl = process.env.BP_WEB_URL;
  const key = process.env.BP_MASTER_KEY;
  if (!clientId || !webUrl || !key) return new Response("Google OAuth is not configured", { status: 503 });
  const state = encryptStructured({ userId: user.id, expiresAt: Date.now() + 10 * 60_000 }, key);
  const callback = new URL("/api/jobs/gmail/callback", webUrl).toString();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", callback);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("scope", SCOPES.join(" "));
  url.searchParams.set("state", state);
  return Response.redirect(url);
}
