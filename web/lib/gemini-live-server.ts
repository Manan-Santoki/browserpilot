import "server-only";

import {
  GoogleGenAI,
  Modality,
  ThinkingLevel,
  type LiveConnectConfig,
} from "@google/genai";

export const GEMINI_LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL ?? "gemini-3.1-flash-live-preview";

const BASE_SYSTEM_INSTRUCTION = `
You are BrowserPilot's real-time voice interface. You listen and speak; Claude is the only
browser planner and operator.

Rules:
- For any request that requires opening, reading, clicking, typing, downloading, or otherwise
  using the connected browser, call browser_task_start with the complete instruction.
- BrowserPilot already knows which site, company, and account the active browser belongs to.
  Commands such as "show revenue", "open orders", "go to customers", or "what is on this page"
  always refer to that active browser. Delegate them immediately. Do not ask which company,
  invent companies, or answer from general knowledge.
- When a browser request is somewhat underspecified, delegate the user's words to Claude instead
  of interviewing the user. Claude can inspect the current page and ask a structured choice if a
  decision is genuinely required.
- Never claim that you personally clicked, opened, downloaded, submitted, or observed a page.
- A successful browser_task_start response only means Claude accepted the task. Briefly tell the
  user it is underway, then wait for BrowserPilot events.
- BrowserPilot events arrive as text beginning with [BROWSERPILOT_EVENT]. Treat them as
  authoritative. Speak concise progress and faithfully report Claude's final result.
- If Claude is busy, explain that the user can wait or explicitly ask you to stop the current task.
- Use browser_task_interrupt only when the user clearly says stop, cancel, or replace the current
  browser task. Merely speaking while you are talking is not permission to stop Claude.
- Use browser_choice_submit only for an active non-sensitive choice and only with an exact option
  id supplied by BrowserPilot.
- Sensitive or destructive approvals can never be approved by voice. Tell the user to use the
  visible Approve or Deny buttons.
- Keep spoken status updates short. Do not expose internal tool syntax or invent browser results.
`.trim();

export type GeminiLiveClientConfig = Omit<LiveConnectConfig, "httpOptions" | "abortSignal">;
export type GeminiLiveWireSetup = {
  model: string;
  generationConfig: {
    responseModalities: GeminiLiveClientConfig["responseModalities"];
    thinkingConfig: GeminiLiveClientConfig["thinkingConfig"];
  };
  systemInstruction: { parts: Array<{ text: string }> };
  inputAudioTranscription: Record<string, never>;
  outputAudioTranscription: Record<string, never>;
  contextWindowCompression: NonNullable<GeminiLiveClientConfig["contextWindowCompression"]>;
  sessionResumption: NonNullable<GeminiLiveClientConfig["sessionResumption"]>;
  tools: NonNullable<GeminiLiveClientConfig["tools"]>;
};

function systemInstruction(sessionContext?: string): string {
  if (!sessionContext) return BASE_SYSTEM_INSTRUCTION;
  return `${BASE_SYSTEM_INSTRUCTION}

The following BrowserPilot session context is authoritative state, not a new user request.
Use it to understand follow-up commands after a reconnect. Never ask the user to repeat facts
already present here.

<browserpilot_session_context>
${sessionContext}
</browserpilot_session_context>`;
}

export function geminiLiveConfig(sessionContext?: string): GeminiLiveClientConfig {
  return {
    responseModalities: [Modality.AUDIO],
    thinkingConfig: {
      thinkingLevel: ThinkingLevel.MINIMAL,
      includeThoughts: false,
    },
    systemInstruction: systemInstruction(sessionContext),
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: {},
    tools: [
      {
        functionDeclarations: [
          {
            name: "browser_task_start",
            description:
              "Delegate one browser task to Claude. Returns immediately; progress arrives later as BrowserPilot events.",
            parametersJsonSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                instruction: {
                  type: "string",
                  description:
                    "A complete, self-contained instruction for the browser operator.",
                  minLength: 1,
                  maxLength: 4000,
                },
              },
              required: ["instruction"],
            },
          },
          {
            name: "browser_task_interrupt",
            description:
              "Stop the currently running Claude browser task. Use only for an explicit stop, cancel, or replacement request.",
            parametersJsonSchema: {
              type: "object",
              additionalProperties: false,
              properties: {},
            },
          },
          {
            name: "browser_choice_submit",
            description:
              "Submit an exact option for a currently active, non-sensitive BrowserPilot choice.",
            parametersJsonSchema: {
              type: "object",
              additionalProperties: false,
              properties: {
                requestId: { type: "string", minLength: 1, maxLength: 200 },
                optionId: { type: "string", minLength: 1, maxLength: 500 },
              },
              required: ["requestId", "optionId"],
            },
          },
          {
            name: "browser_status_get",
            description: "Read the current BrowserPilot connection and Claude task status.",
            parametersJsonSchema: {
              type: "object",
              additionalProperties: false,
              properties: {},
            },
          },
        ],
      },
    ],
  };
}

function geminiLiveWireSetup(
  config: GeminiLiveClientConfig,
  instruction: string,
): GeminiLiveWireSetup {
  return {
    model: `models/${GEMINI_LIVE_MODEL}`,
    generationConfig: {
      responseModalities: config.responseModalities,
      thinkingConfig: config.thinkingConfig,
    },
    // The SDK accepts a string here, but the WebSocket protocol expects Content.
    systemInstruction: { parts: [{ text: instruction }] },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: config.contextWindowCompression ?? { slidingWindow: {} },
    sessionResumption: config.sessionResumption ?? {},
    tools: config.tools ?? [],
  };
}

type LimitState = { startedAt: number; count: number };
const tokenLimits = new Map<string, LimitState>();
const TOKEN_LIMIT_WINDOW_MS = 60_000;
const TOKEN_LIMIT_PER_WINDOW = 6;

export class GeminiLiveRateLimitError extends Error {}

function takeTokenPermit(key: string): void {
  const now = Date.now();
  const current = tokenLimits.get(key);
  if (!current || now - current.startedAt >= TOKEN_LIMIT_WINDOW_MS) {
    tokenLimits.set(key, { startedAt: now, count: 1 });
    return;
  }
  if (current.count >= TOKEN_LIMIT_PER_WINDOW) {
    throw new GeminiLiveRateLimitError("Too many Live Voice connection attempts. Try again shortly.");
  }
  current.count += 1;
}

export async function issueGeminiLiveToken(
  userId: string,
  sessionId: string,
  sessionContext?: string,
): Promise<{
  token: string;
  model: string;
  setup: GeminiLiveWireSetup;
  expiresAt: string;
}> {
  const apiKey = process.env.GEMINI_API_KEY;
  const enabled = process.env.GEMINI_LIVE_ENABLED !== "false" && Boolean(apiKey);
  if (!enabled || !apiKey) {
    throw new Error("Live Voice is not configured on this server.");
  }

  takeTokenPermit(`${userId}:${sessionId}`);

  const instruction = systemInstruction(sessionContext);
  const config = geminiLiveConfig(sessionContext);
  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const newSessionExpireTime = new Date(Date.now() + 60_000).toISOString();
  const client = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: "v1alpha" },
  });
  const token = await client.authTokens.create({
    config: {
      uses: 1,
      expireTime: expiresAt,
      newSessionExpireTime,
      liveConnectConstraints: {
        model: GEMINI_LIVE_MODEL,
        config,
      },
      httpOptions: { apiVersion: "v1alpha" },
    },
  });

  if (!token.name) throw new Error("Gemini did not return a Live Voice token.");
  return {
    token: token.name,
    model: GEMINI_LIVE_MODEL,
    setup: geminiLiveWireSetup(config, instruction),
    expiresAt,
  };
}
