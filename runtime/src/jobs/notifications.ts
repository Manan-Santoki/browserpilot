import type { Store } from "../store";
import { GmailClient } from "./gmail";

export class NotificationWorker {
  private ticking = false;
  constructor(
    private store: Store,
    private clientId: string,
    private clientSecret: string,
    private onStatus?: (applicationId: string | null, status: "sending" | "sent" | "failed") => void,
  ) {}

  private async status(applicationId: string | null, value: "sending" | "sent" | "failed"): Promise<void> {
    await this.store.recordNotificationStatus(applicationId, value);
    this.onStatus?.(applicationId, value);
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const notification = await this.store.claimNotification();
      if (!notification) return;
      await this.status(notification.applicationId, "sending");
      const credentials = await this.store.gmailCredentials(notification.userId);
      if (!credentials) {
        await this.store.finishNotification(notification, new Error("Gmail is not connected"));
        await this.status(notification.applicationId, "failed");
        return;
      }
      try {
        const gmail = new GmailClient({ clientId: this.clientId, clientSecret: this.clientSecret, ...credentials });
        await gmail.sendStatus(notification.toEmail, `BrowserPilot: ${notification.template.replaceAll("-", " ")}`, String(notification.payload.message ?? "Application status changed"));
        await this.store.finishNotification(notification);
        await this.status(notification.applicationId, "sent");
      } catch (error) {
        await this.store.finishNotification(notification, error as Error);
        await this.status(notification.applicationId, "failed");
      }
    } finally { this.ticking = false; }
  }
}
