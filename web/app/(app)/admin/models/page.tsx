import { settings } from "@browserpilot/db";
import { parseStoredCatalogue } from "@browserpilot/core";
import { requireAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { runtimeProviderStatus } from "@/lib/runtime";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ProviderForm } from "./form";

export default async function ModelsPage() {
  const admin = await requireAdmin();
  const status = await runtimeProviderStatus(admin);

  const rows = await db().select().from(settings);
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));

  // Everything except the credential, which is sealed and never comes back out.
  const current = {
    format: stored.providerFormat === "openai" ? "openai" : "anthropic",
    baseUrl: String(stored.providerBaseUrl ?? ""),
    credentialKind: ["oauth", "apiKey", "authToken"].includes(String(stored.providerCredentialKind))
      ? String(stored.providerCredentialKind)
      : "apiKey",
    hasCredential: typeof stored.providerCredential === "string",
    models: parseStoredCatalogue(stored.providerModels),
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Models</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Which service the agent sends its thinking to, and which models it may run there. Changes
          apply to the next session that starts — no redeploy.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Right now</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          {!status.ok ? (
            <p className="text-destructive">
              The browser service did not answer, so this cannot be confirmed: {status.error}
            </p>
          ) : !status.data.configured ? (
            <p className="text-destructive">
              <span className="lamp lamp-waiting" aria-hidden /> No provider is configured. Sessions
              cannot start until one is saved below.
            </p>
          ) : status.data.reachable ? (
            <p>
              <span className="lamp lamp-idle" aria-hidden />{" "}
              <span className="font-mono text-xs">{status.data.model}</span> answered from{" "}
              <span className="font-mono text-xs">{status.data.endpoint}</span>
              {status.data.rateLimited
                ? " — rate limited, but the address and credential are right."
                : ` in ${status.data.latencyMs}ms.`}
            </p>
          ) : (
            <p className="text-destructive">
              <span className="lamp lamp-waiting" aria-hidden />{" "}
              <span className="font-mono text-xs">{status.data.endpoint}</span> did not answer for{" "}
              <span className="font-mono text-xs">{status.data.model}</span>
              {status.data.error ? `: ${status.data.error}` : "."}
            </p>
          )}
        </CardContent>
      </Card>

      <ProviderForm current={current} />
    </div>
  );
}
