import { parseGmailVerification } from "@browserpilot/core";

export type GmailFetch = typeof fetch;

export type GmailCredentials = {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountEmail: string;
};

function decodeBody(data?: string): string {
  if (!data) return "";
  return Buffer.from(data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function messageText(payload: { body?: { data?: string }; parts?: Array<{ mimeType?: string; body?: { data?: string }; parts?: unknown[] }> }): string {
  const direct = decodeBody(payload.body?.data);
  if (direct) return direct;
  const parts = payload.parts ?? [];
  return parts.filter((part) => part.mimeType === "text/plain" || part.mimeType === "text/html")
    .map((part) => decodeBody(part.body?.data)).join("\n");
}

export class GmailClient {
  constructor(private credentials: GmailCredentials, private request: GmailFetch = fetch) {}

  private async accessToken(): Promise<string> {
    const response = await this.request("https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.credentials.clientId, client_secret: this.credentials.clientSecret, refresh_token: this.credentials.refreshToken, grant_type: "refresh_token" }),
    });
    const body = await response.json() as { access_token?: string; error?: string };
    if (!response.ok || !body.access_token) throw new Error(body.error ?? "Gmail access was revoked");
    return body.access_token;
  }

  async findVerification(
    after: Date,
    portalHost: string,
    recipientEmail = this.credentials.accountEmail,
  ): Promise<{ code?: string; link?: string } | null> {
    const token = await this.accessToken();
    const query = `to:${recipientEmail} after:${Math.floor(after.getTime() / 1000)} (${portalHost})`;
    const listUrl = new URL("https://gmail.googleapis.com/gmail/v1/users/me/messages");
    listUrl.searchParams.set("q", query);
    listUrl.searchParams.set("maxResults", "10");
    const listed = await this.request(listUrl, { headers: { authorization: `Bearer ${token}` } });
    const listing = await listed.json() as { messages?: Array<{ id: string }> };
    if (!listed.ok) throw new Error("Gmail verification search failed");
    for (const message of listing.messages ?? []) {
      const response = await this.request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full`, { headers: { authorization: `Bearer ${token}` } });
      const found = await response.json() as { internalDate?: string; payload?: Parameters<typeof messageText>[0] };
      if (!response.ok || !found.payload || Number(found.internalDate ?? 0) < after.getTime()) continue;
      const parsed = parseGmailVerification(messageText(found.payload), [portalHost]);
      if (parsed.code || parsed.link) return parsed;
    }
    return null;
  }

  async sendStatus(to: string, subject: string, text: string): Promise<void> {
    const token = await this.accessToken();
    const raw = Buffer.from(`To: ${to}\r\nFrom: ${this.credentials.accountEmail}\r\nSubject: ${subject.replace(/[\r\n]/g, " ")}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}`)
      .toString("base64url");
    const response = await this.request("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ raw }),
    });
    if (!response.ok) throw new Error("Gmail status delivery failed");
  }
}
