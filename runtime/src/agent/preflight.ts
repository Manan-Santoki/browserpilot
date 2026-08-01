import type { WireFormat } from "@browserpilot/core";
import type { AiCredential } from "../config";

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

/**
 * The part of a provider this check needs.
 *
 * Deliberately narrower than `RuntimeConfig`: the console probes whatever an
 * administrator has just saved, which is not what the process booted with.
 */
export type ProviderTarget = {
  baseUrl?: string;
  credential: AiCredential;
  /** Which API to speak. Anthropic when unsaid, as that is the older path. */
  format?: WireFormat;
};

/** Where the chat endpoint lives for this provider, in its own dialect. */
export function messagesEndpoint(target: ProviderTarget): string {
  const base = target.baseUrl ?? "https://api.anthropic.com";
  return target.format === "openai" ? `${base}/v1/chat/completions` : `${base}/v1/messages`;
}

/**
 * The auth headers for one credential, at one endpoint.
 *
 * The format matters as much as the credential kind, which is not obvious and
 * cost a real debugging session to find: OpenCode's Anthropic endpoint answers
 * 401 to `Authorization: Bearer` and 200 to `x-api-key`, and its OpenAI
 * endpoint — same host, same key — answers the exact opposite. `x-api-key` is
 * an Anthropic convention and simply is not part of OpenAI's, so an
 * OpenAI-format endpoint always gets the bearer header.
 *
 * The subscription token additionally needs Anthropic's OAuth beta header,
 * which a gateway neither wants nor understands — so it is scoped to that kind
 * rather than sent to everyone.
 */
export function providerHeaders(
  credential: AiCredential,
  format: WireFormat = "anthropic",
): Record<string, string> {
  if (format === "openai") return { authorization: `Bearer ${credential.value}` };

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
function explain(
  status: number,
  body: string,
  credential: AiCredential,
  format: WireFormat | undefined,
): string {
  const detail = body.trim().slice(0, 300) || "(empty response)";
  switch (status) {
    case 401:
    case 403: {
      // Which header the key rode in is the fix or the dead end, and it is not
      // visible from a bare 401. Against an Anthropic-format endpoint the
      // choice is the operator's — gateways disagree, and OpenCode wants
      // `x-api-key` despite issuing an `sk-` key that reads like a bearer
      // token. Against an OpenAI-format one there is no choice to offer:
      // `x-api-key` is not part of that convention at all.
      if (format === "openai") {
        return `credential rejected — the key was sent as Authorization: Bearer, which is the only header this API uses. The key itself is wrong, or has no access to this model. ${detail}`;
      }

      const sent = credential.kind === "apiKey" ? "x-api-key" : "Authorization: Bearer";
      const other =
        credential.kind === "apiKey"
          ? "ANTHROPIC_AUTH_TOKEN (sends Authorization: Bearer)"
          : "ANTHROPIC_API_KEY (sends x-api-key)";
      return `credential rejected — the key was sent as ${sent}. If the key itself is right, this provider may want the other header: move it to ${other}. ${detail}`;
    }
    case 404:
      return `no API here — check the provider address (the Models page, or BP_ANTHROPIC_BASE_URL), and that the model id exists on this provider. ${detail}`;
    case 400:
      return `request rejected — usually an unknown model id. ${detail}`;
    default:
      return detail;
  }
}

export async function checkProvider(
  target: ProviderTarget,
  model: string,
  deps: PreflightDeps = {},
): Promise<ProviderCheck> {
  const fetchFn = deps.fetchFn ?? fetch;
  const endpoint = messagesEndpoint(target);
  const started = Date.now();
  const openai = target.format === "openai";

  try {
    const response = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // Harmless to an OpenAI-format endpoint, and required by Anthropic's.
        "anthropic-version": "2023-06-01",
        ...providerHeaders(target.credential, target.format),
      },
      // The smallest request that still exercises auth, routing and the model
      // id. It stops at the first token, so it costs approximately nothing.
      body: JSON.stringify({
        model,
        ...(openai ? { max_completion_tokens: 1 } : { max_tokens: 1 }),
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
        detail: explain(response.status, body, target.credential, target.format),
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
