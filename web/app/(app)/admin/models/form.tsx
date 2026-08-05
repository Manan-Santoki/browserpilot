"use client";

import { useActionState, useState } from "react";
import { KNOWN_MODELS, type ModelChoice } from "@browserpilot/core";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { saveProviderSettings, type AdminState } from "../actions";
import { AdminSaveBar, AdminSection } from "../shell";

const initial: AdminState = {};

const FORMATS = [
  { value: "anthropic", label: "Anthropic Messages API" },
  { value: "openai", label: "OpenAI chat completions" },
];

const CREDENTIAL_KINDS = [
  { value: "apiKey", label: "API key (x-api-key header)" },
  { value: "authToken", label: "Bearer token (Authorization header)" },
  { value: "oauth", label: "Claude subscription (OAuth) token" },
];

type Current = {
  format: string;
  baseUrl: string;
  credentialKind: string;
  hasCredential: boolean;
  models: ModelChoice[];
};

type Probe = { pending?: boolean; ok?: boolean; detail?: string };

export function ProviderForm({ current }: { current: Current }) {
  const [state, action, pending] = useActionState(saveProviderSettings, initial);
  const [format, setFormat] = useState(current.format);
  const [credentialKind, setCredentialKind] = useState(current.credentialKind);
  const [models, setModels] = useState<ModelChoice[]>(current.models);
  const [probes, setProbes] = useState<Record<string, Probe>>({});

  const unlisted = KNOWN_MODELS.filter((known) => !models.some((m) => m.value === known.value));

  function update(index: number, patch: Partial<ModelChoice>) {
    setModels((list) => list.map((m, i) => (i === index ? { ...m, ...patch } : m)));
  }

  async function test(model: string) {
    setProbes((p) => ({ ...p, [model]: { pending: true } }));
    try {
      const response = await fetch(`/api/admin/provider-check?model=${encodeURIComponent(model)}`);
      const body = (await response.json()) as {
        reachable?: boolean;
        rateLimited?: boolean;
        latencyMs?: number;
        error?: string;
      };
      setProbes((p) => ({
        ...p,
        [model]: {
          ok: Boolean(body.reachable),
          detail: body.reachable
            ? body.rateLimited
              ? "answered (rate limited)"
              : `answered in ${body.latencyMs}ms`
            : (body.error ?? "no answer"),
        },
      }));
    } catch (error) {
      setProbes((p) => ({ ...p, [model]: { ok: false, detail: (error as Error).message } }));
    }
  }

  return (
    <form action={action} className="space-y-6">
      <input type="hidden" name="providerModels" value={JSON.stringify(models)} />

      <AdminSection
        title="Where the agent thinks"
        description="Leave the address empty to use Anthropic directly. Point it at a gateway — OpenCode, or anything that speaks either API — to run other models instead."
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="providerBaseUrl">
              Address <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              id="providerBaseUrl"
              name="providerBaseUrl"
              defaultValue={current.baseUrl}
              placeholder="https://opencode.ai/zen/go"
            />
            <p className="text-muted-foreground text-xs">
              Paste the documented endpoint if that is what you have — the{" "}
              <span className="font-mono">/v1/messages</span> part is trimmed off for you.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="providerFormat">API it speaks</Label>
            <Select
              name="providerFormat"
              value={format}
              onValueChange={(v) => setFormat(v ?? "anthropic")}
              items={FORMATS}
            >
              <SelectTrigger id="providerFormat" className="w-full" aria-label="Wire format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMATS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">
              How requests are framed. A model in the list below can override this, so one gateway
              can serve both kinds.
            </p>
          </div>
        </div>
      </AdminSection>

      <AdminSection
        title="Credential"
        description="The same key in the wrong header is a bare 401, so how it is sent matters. If a provider rejects you, try the other kind."
      >
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="providerCredentialKind">Type of key</Label>
            <Select
              name="providerCredentialKind"
              value={credentialKind}
              onValueChange={(v) => setCredentialKind(v ?? "apiKey")}
              items={CREDENTIAL_KINDS}
            >
              <SelectTrigger id="providerCredentialKind" className="w-full" aria-label="Credential kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CREDENTIAL_KINDS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="providerCredential">Key</Label>
            <Input
              id="providerCredential"
              name="providerCredential"
              type="password"
              placeholder={current.hasCredential ? "•••••••• (leave empty to keep)" : ""}
            />
            <p className="text-muted-foreground text-xs">
              Encrypted before it is stored, and never shown again.
            </p>
          </div>
        </div>
      </AdminSection>

      <AdminSection
        title="Models on offer"
        description="Exactly these appear in the session picker. A model that cannot see images still drives pages perfectly — it reads them as structure — but it cannot answer “what does this look like”."
      >
        <div className="space-y-4">
          {models.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              None yet. Add one below, or pick from the models we have tested.
            </p>
          ) : null}

          <ul className="space-y-3">
            {models.map((model, index) => {
              const probe = probes[model.value];
              return (
                <li key={`${model.value}-${index}`} className="rounded-lg border p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      aria-label="Model id"
                      value={model.value}
                      onChange={(e) => update(index, { value: e.target.value })}
                      className="w-48 font-mono text-xs"
                    />
                    <Input
                      aria-label="Shown as"
                      value={model.label}
                      onChange={(e) => update(index, { label: e.target.value })}
                      className="min-w-40 flex-1"
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void test(model.value)}
                      disabled={probe?.pending || !model.value}
                    >
                      {probe?.pending ? "Testing…" : "Test"}
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setModels((list) => list.filter((_, i) => i !== index))}
                    >
                      Remove
                    </Button>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-2 text-sm">
                      <Switch
                        checked={model.vision}
                        onCheckedChange={(on) => update(index, { vision: Boolean(on) })}
                      />
                      <span>Can read screenshots</span>
                    </label>
                    <label className="flex items-center gap-2 text-sm">
                      <Switch
                        checked={model.format === "openai"}
                        onCheckedChange={(on) =>
                          update(index, { format: on ? "openai" : "anthropic" })
                        }
                      />
                      <span>Speaks the OpenAI API</span>
                    </label>
                  </div>

                  {probe && !probe.pending ? (
                    <p className={`mt-2 text-xs ${probe.ok ? "text-running" : "text-destructive"}`}>
                      {probe.ok ? "✓" : "✗"} {probe.detail}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setModels((list) => [
                  ...list,
                  { value: "", label: "", vision: true, format: format as ModelChoice["format"] },
                ])
              }
            >
              Add a model
            </Button>
          </div>

          {unlisted.length > 0 ? (
            <div className="space-y-2 border-t pt-4">
              <p className="text-muted-foreground text-xs">
                Tested by us — the flags come from actually running each one:
              </p>
              <div className="flex flex-wrap gap-2">
                {unlisted.map((known) => (
                  <Button
                    key={known.value}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setModels((list) => [...list, known])}
                  >
                    + {known.label}
                    {known.vision ? "" : " (no vision)"}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </AdminSection>

      <AdminSaveBar pending={pending} label="Save provider" error={state.error} success={state.success} />
    </form>
  );
}
