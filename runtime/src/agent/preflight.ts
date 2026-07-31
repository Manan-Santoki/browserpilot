import type { AiCredential, RuntimeConfig } from "../config";

/**
 * Ask the configured provider whether it will actually answer.
 *
 * Everything about pointing the agent somewhere new — the base URL, which
 * header the token belongs in, whether the model id means anything there — is
 * invisible until a session runs, and then it surfaces as an agent that says
 * nothing while a browser sits open costing memory. One small request at boot
 * turns all of that into a line in the log.
 *
 * It is deliberately not fatal. A provider that is briefly unreachable should
 * not stop a service whose other half — sessions, files, the console — is
 * fine, and whose next request may well succeed.
 */

export type ProviderCheck =
  | {
      ok: true;
      endpoint: string;
      model: string;
      latencyMs: number;
      /**
       * The provider answered, but with a quota error rather than a message.
       * Still a pass: the question here is whether this deployment is pointed
       * and authenticated correctly, and a 429 can only come from a provider
       * that recognised both the route and the credential.
       */
      rateLimited?: boolean;
    }
  | { ok: false; endpoint: string; model: string; status?: number; detail: string };

export type PreflightDeps = {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
};

/** Where the Messages API lives for this provider. */
export function messagesEndpoint(config: RuntimeConfig): string {
  return `${config.provider.baseUrl ?? "https://api.anthropic.com"}/v1/messages`;
}

/**
 * The auth headers for one credential kind.
 *
 * An API key rides `x-api-key`; both bearer kinds ride `Authorization`. The
 * subscription token additionally needs Anthropic's OAuth beta header, which
 * a gateway neither wants nor understands — so it is scoped to that kind
 * rather than sent to everyone.
 */
export function providerHeaders(credential: AiCredential): Record<string, string> {
  switch (credential.kind) {
    case "apiKey":
      return { "x-api-key": credential.value };
    case "oauth":
      return {
        authorization: `Bearer ${credential.value}`,
        "anthropic-beta": "oauth-2025-04-20",
      };
    case "authToken":
      return { authorization: `Bearer ${credential.value}` };
  }
}

/** Turn a non-2xx into something a person can act on. */
function explain(status: number, body: string, credential: AiCredential): string {
  const detail = body.trim().slice(0, 300) || "(empty response)";
  switch (status) {
    case 401:
    case 403: {
      // Which variable holds the key *is* which header it is sent in, and
      // gateways disagree about which one they want — OpenCode wants
      // `x-api-key` despite documenting a `sk-` key that looks like a bearer
      // token. Naming both sides turns a bare 401 into a one-line fix.
      const sent = credential.kind === "apiKey" ? "x-api-key" : "Authorization: Bearer";
      const other =
        credential.kind === "apiKey"
          ? "ANTHROPIC_AUTH_TOKEN (sends Authorization: Bearer)"
          : "ANTHROPIC_API_KEY (sends x-api-key)";
      return `credential rejected — the key was sent as ${sent}. If the key itself is right, this provider may want the other header: move it to ${other}. ${detail}`;
    }
    case 404:
      return `no Messages API here — check BP_ANTHROPIC_BASE_URL, and that the model id exists on this provider. ${detail}`;
    case 400:
      return `request rejected — usually an unknown model id. ${detail}`;
    default:
      return detail;
  }
}

export async function checkProvider(
  config: RuntimeConfig,
  model: string = config.defaultModel,
  deps: PreflightDeps = {},
): Promise<ProviderCheck> {
  const fetchFn = deps.fetchFn ?? fetch;
  const endpoint = messagesEndpoint(config);
  const started = Date.now();

  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        ...providerHeaders(config.provider.credential),
      },
      // The smallest request that still exercises auth, routing and the model
      // id. It stops at the first token, so it costs approximately nothing.
      body: JSON.stringify({
        model,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
      signal: AbortSignal.timeout(deps.timeoutMs ?? 15_000),
    });

    const latencyMs = Date.now() - started;

    // A quota error is the provider telling us it understood the request. That
    // is exactly what this check asks, so it passes — a deploy gate that
    // failed here would block on a busy account rather than a broken one.
    if (response.status === 429) {
      return { ok: true, endpoint, model, latencyMs, rateLimited: true };
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return {
        ok: false,
        endpoint,
        model,
        status: response.status,
        detail: explain(response.status, body, config.provider.credential),
      };
    }

    return { ok: true, endpoint, model, latencyMs };
  } catch (error) {
    const message = (error as Error).message;
    return {
      ok: false,
      endpoint,
      model,
      detail:
        (error as Error).name === "TimeoutError"
          ? `no response within ${deps.timeoutMs ?? 15_000}ms`
          : `could not reach the provider: ${message}`,
    };
  }
}

/** One line for the boot log, prefixed so it is greppable in a container. */
export function formatCheck(check: ProviderCheck): string {
  if (check.ok) {
    const how = check.rateLimited
      ? "reachable but rate limited (endpoint and credential are correct)"
      : "ok";
    return `provider ${how} — ${check.model} at ${check.endpoint} in ${check.latencyMs}ms`;
  }
  return `provider UNREACHABLE — ${check.model} at ${check.endpoint}${
    check.status ? ` (HTTP ${check.status})` : ""
  }: ${check.detail}`;
}
