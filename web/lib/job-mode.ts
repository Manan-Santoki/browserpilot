import "server-only";

import { isJobModeEnabled } from "@browserpilot/core";
import { notFound } from "next/navigation";

export function jobModeEnabled(): boolean {
  return isJobModeEnabled(process.env);
}

/** Hide beta surfaces instead of disclosing that a disabled feature exists. */
export function requireJobModeEnabled(): void {
  if (!jobModeEnabled()) notFound();
}
