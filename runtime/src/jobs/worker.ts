import { randomUUID } from "node:crypto";
import { SessionError, type SessionManager } from "../session/manager";
import type { Store } from "../store";

/** Durable queue consumer. The database lease is the source of truth, not this timer. */
export class JobWorker {
  private readonly workerId = `runtime-${randomUUID()}`;
  private ticking = false;

  constructor(private store: Store, private manager: SessionManager) {}

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const application = await this.store.claimJob(this.workerId);
      if (!application) return;
      try {
        const issues = await this.store.jobConfigurationIssues(application.userId, application.id);
        if (issues.length) {
          await this.store.pauseJob(application.userId, application.id, issues.join(". "));
          return;
        }
        await this.manager.createJob(application);
      } catch (error) {
        if (error instanceof SessionError && ["global_limit", "user_limit"].includes(error.code)) {
          await this.store.releaseJob(application.userId, application.id);
          return;
        }
        await this.store.failJob(application.userId, application.id, "The application browser could not start");
      }
    } finally {
      this.ticking = false;
    }
  }
}
