import { isJobModeEnabled } from "@browserpilot/core";

export function proxy(): Response | undefined {
  if (!isJobModeEnabled(process.env)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}

export const config = {
  matcher: ["/jobs/:path*", "/api/jobs/:path*"],
};
