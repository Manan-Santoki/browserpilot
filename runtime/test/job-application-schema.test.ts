import { describe, expect, test } from "bun:test";
import { getAtsApplicationSchema, schemaRequiresManualLegalReview } from "../src/jobs/application-schema";

describe("deterministic ATS application schemas", () => {
  test("Greenhouse labels and options are returned verbatim from its fixed public API host", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json({ questions: [{
        label: "Are you legally authorized to work in this country?",
        required: true,
        fields: [{
          name: "question_1",
          type: "multi_value_single_select",
          values: [
            { label: "I require sponsorship to work in this country" },
            { label: "My status to work in this country is unknown" },
          ],
        }],
      }] });
    }) as unknown as typeof fetch;

    const result = await getAtsApplicationSchema(
      "https://www.asm.com/open-vacancies/software-engineering-intern?gh_jid=4830113101&jobPipeline=IndeedITA",
      { boardToken: "asm" },
      fakeFetch,
    );

    expect(calls).toEqual(["https://boards-api.greenhouse.io/v1/boards/asm/jobs/4830113101?questions=true"]);
    expect(result).toEqual({
      available: true,
      provider: "greenhouse",
      jobId: "4830113101",
      questions: [{
        label: "Are you legally authorized to work in this country?",
        required: true,
        fields: [{
          name: "question_1",
          type: "multi_value_single_select",
          values: [
            "I require sponsorship to work in this country",
            "My status to work in this country is unknown",
          ],
        }],
      }],
    });
  });

  test("rejects model-supplied hosts and malformed board tokens without fetching", async () => {
    let fetched = false;
    const fakeFetch = (async () => {
      fetched = true;
      return Response.json({});
    }) as unknown as typeof fetch;
    const result = await getAtsApplicationSchema(
      "https://www.asm.com/job?gh_jid=4830113101",
      { boardToken: "asm/../../metadata" },
      fakeFetch,
    );
    expect(result.available).toBe(false);
    expect(fetched).toBe(false);
  });

  test("does not offer a fake schema for an unsupported ATS", async () => {
    const result = await getAtsApplicationSchema("https://jobs.example.com/1", { boardToken: "asm" });
    expect(result).toEqual({ available: false, reason: "No deterministic schema adapter is available for this ATS" });
  });

  test("detects required legal declarations independently of the model inventory", () => {
    expect(schemaRequiresManualLegalReview({
      available: true,
      provider: "greenhouse",
      jobId: "1",
      questions: [{
        label: "I authorize the employer to verify this application and release all parties from liability.",
        required: true,
        fields: [{ name: "legal", type: "multi_value_single_select", values: ["Yes"] }],
      }],
    })).toBe(true);
    expect(schemaRequiresManualLegalReview({
      available: true,
      provider: "greenhouse",
      jobId: "1",
      questions: [{
        label: "Will you require sponsorship?",
        required: true,
        fields: [{ name: "sponsor", type: "multi_value_single_select", values: ["Yes", "No"] }],
      }],
    })).toBe(false);
  });
});
