import { detectAts } from "@browserpilot/core";

export type AtsApplicationQuestion = {
  label: string;
  required: boolean;
  fields: Array<{ name: string; type: string; values: string[] }>;
};

export type AtsApplicationSchema =
  | { available: true; provider: "greenhouse"; jobId: string; questions: AtsApplicationQuestion[] }
  | { available: false; reason: string };

/** Required single-Yes legal declarations must be reviewed by the candidate. */
export function schemaRequiresManualLegalReview(schema: AtsApplicationSchema): boolean {
  if (!schema.available) return false;
  return schema.questions.some((question) => {
    const values = question.fields.flatMap((field) => field.values);
    return question.required && values.length === 1 && values[0] === "Yes" &&
      (question.label.length > 500 || /\b(authorize|declare|liability|terms of use|privacy notice)\b/i.test(question.label));
  });
}

type GreenhouseQuestionResponse = {
  questions?: Array<{
    label?: unknown;
    required?: unknown;
    fields?: Array<{
      name?: unknown;
      type?: unknown;
      values?: Array<{ label?: unknown }>;
    }>;
  }>;
};

/**
 * Retrieve the public ATS schema from a fixed provider host.
 *
 * The model may supply only a board token it read from the employer page. It
 * cannot choose a hostname or URL, and the numeric job id remains bound to the
 * user-submitted application URL. This gives the agent exact labels/options
 * without turning the runtime into an SSRF proxy.
 */
export async function getAtsApplicationSchema(
  sourceUrl: string,
  input: { boardToken?: string },
  fetchImpl: typeof fetch = fetch,
): Promise<AtsApplicationSchema> {
  if (detectAts(sourceUrl) !== "greenhouse") {
    return { available: false, reason: "No deterministic schema adapter is available for this ATS" };
  }
  const source = new URL(sourceUrl);
  const jobId = source.searchParams.get("gh_jid") ?? source.pathname.match(/\/jobs\/(\d+)/)?.[1];
  if (!jobId || !/^\d+$/.test(jobId)) {
    return { available: false, reason: "The Greenhouse job id is unavailable" };
  }
  const boardToken = input.boardToken?.trim();
  if (!boardToken || !/^[a-z0-9_-]{1,100}$/i.test(boardToken)) {
    return { available: false, reason: "Read the Greenhouse board token from the page's embed script or iframe" };
  }

  const endpoint = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs/${jobId}?questions=true`;
  const response = await fetchImpl(endpoint, {
    redirect: "error",
    headers: { accept: "application/json", "user-agent": "BrowserPilot/1.0" },
  });
  if (!response.ok) {
    return { available: false, reason: `Greenhouse schema request returned ${response.status}` };
  }
  const raw = await response.text();
  if (raw.length > 2_000_000) return { available: false, reason: "Greenhouse schema response was too large" };
  let data: GreenhouseQuestionResponse;
  try {
    data = JSON.parse(raw) as GreenhouseQuestionResponse;
  } catch {
    return { available: false, reason: "Greenhouse schema response was not valid JSON" };
  }

  const questions = (data.questions ?? []).flatMap((question): AtsApplicationQuestion[] => {
    if (typeof question.label !== "string" || !question.label.trim()) return [];
    return [{
      label: question.label,
      required: question.required === true,
      fields: (question.fields ?? []).flatMap((field) => {
        if (typeof field.name !== "string" || typeof field.type !== "string") return [];
        return [{
          name: field.name,
          type: field.type,
          values: (field.values ?? []).flatMap((value) => typeof value.label === "string" ? [value.label] : []),
        }];
      }),
    }];
  });
  return { available: true, provider: "greenhouse", jobId, questions };
}
