import { describe, expect, test } from "bun:test";
import { GmailClient } from "../src/jobs/gmail";

const credentials = { clientId: "client", clientSecret: "secret", refreshToken: "refresh", accountEmail: "candidate@example.com" };

describe("job Gmail integration", () => {
  test("searches only after the application action and parses locally", async () => {
    const seen: string[] = [];
    const fake = (async (input: string | URL | Request) => {
      const url = String(input);
      seen.push(url);
      if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "access" });
      if (url.includes("/messages?") || url.endsWith("/messages")) return Response.json({ messages: [{ id: "m1" }] });
      return Response.json({ internalDate: String(new Date("2026-08-04T12:01:00Z").getTime()), payload: { body: { data: Buffer.from("Your verification code is 481992").toString("base64url") } } });
    }) as typeof fetch;
    const gmail = new GmailClient(credentials, fake);
    expect(await gmail.findVerification(new Date("2026-08-04T12:00:00Z"), "auth.example.com", "applications@example.com")).toEqual({ code: "481992" });
    const search = new URL(seen.find((url) => url.includes("gmail.googleapis.com") && url.includes("messages?"))!);
    expect(search.searchParams.get("q")).toContain("to:applications@example.com");
    expect(search.searchParams.get("q")).toContain("after:1785844800");
  });

  test("sends one RFC822 message without exposing token fields in the request URL", async () => {
    let sent: { raw?: string } = {};
    const fake = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "access" });
      sent = JSON.parse(String(init?.body));
      return Response.json({ id: "sent-1" });
    }) as typeof fetch;
    await new GmailClient(credentials, fake).sendStatus("notify@example.com", "Application submitted", "Confirmed");
    const decoded = Buffer.from(sent.raw!, "base64url").toString("utf8");
    expect(decoded).toContain("To: notify@example.com");
    expect(decoded).toContain("Confirmed");
    expect(decoded).not.toContain("refresh");
  });
});
