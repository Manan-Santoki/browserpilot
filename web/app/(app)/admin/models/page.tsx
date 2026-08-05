import { settings } from "@browserpilot/db";
import { parseStoredCatalogue } from "@browserpilot/core";
import { requirePermission } from "@/lib/auth";
import { db } from "@/lib/db";
import { runtimeProviderStatus } from "@/lib/runtime";
import { AdminHeader, AdminStatus, type StatusItem } from "../shell";
import { ProviderForm } from "./form";

export default async function ModelsPage() {
  const admin = await requirePermission("model.manage");
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

  // How "Right now" reads, proven against the provider rather than described.
  let statusItems: StatusItem[];
  if (!status.ok) {
    statusItems = [
      {
        label: "Provider",
        value: "Unreachable",
        tone: "bad",
        hint: "The browser service did not answer.",
      },
    ];
  } else if (!status.data.configured) {
    statusItems = [
      {
        label: "Provider",
        value: "Not configured",
        tone: "warn",
        hint: "Sessions cannot start until one is saved below.",
      },
    ];
  } else {
    statusItems = [
      {
        label: "Endpoint",
        value: status.data.endpoint ?? "Anthropic",
        tone: status.data.reachable ? "ok" : "bad",
        hint: status.data.error,
      },
      {
        label: "Probed model",
        value: status.data.model ?? "—",
        tone: status.data.reachable ? (status.data.rateLimited ? "warn" : "ok") : "bad",
        hint: status.data.reachable
          ? status.data.rateLimited
            ? "rate limited"
            : `answered in ${status.data.latencyMs}ms`
          : undefined,
      },
    ];
  }

  return (
    <>
      <AdminHeader
        title="Models"
        description="Which service the agent sends its thinking to, and which models it may run there. Changes apply to the next session that starts — no redeploy."
      />

      <AdminStatus items={statusItems} />

      <ProviderForm current={current} />
    </>
  );
}
