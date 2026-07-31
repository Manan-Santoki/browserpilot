"use client";

export type GeminiLiveToken = {
  token: string;
  model: string;
  setup: Record<string, unknown>;
  expiresAt: string;
};

export type GeminiFunctionCall = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
};

type GeminiServerMessage = {
  error?: { code?: number; message?: string; status?: string };
  setupComplete?: Record<string, never>;
  serverContent?: {
    modelTurn?: {
      parts?: Array<{
        inlineData?: { data?: string; mimeType?: string };
      }>;
    };
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
    interrupted?: boolean;
    turnComplete?: boolean;
  };
  toolCall?: { functionCalls?: GeminiFunctionCall[] };
  sessionResumptionUpdate?: { resumable?: boolean; newHandle?: string };
  goAway?: { timeLeft?: string };
};

type Callbacks = {
  onState: (state: "connecting" | "listening" | "reconnecting" | "closed") => void;
  onAudio: (base64Pcm: string) => void;
  onInputTranscript: (text: string) => void;
  onOutputTranscript: (text: string) => void;
  onInterrupted: () => void;
  onTurnComplete: () => void;
  onToolCalls: (calls: GeminiFunctionCall[]) => Promise<
    Array<{ id: string; name: string; response: Record<string, unknown> }>
  >;
  onError: (message: string) => void;
  onDiagnostic?: (event: string, detail?: string) => void;
};

const GEMINI_CONSTRAINED_WS =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const SETUP_TIMEOUT_MS = 15_000;

async function decodeServerMessage(data: unknown): Promise<GeminiServerMessage | null> {
  let json: string;
  if (typeof data === "string") {
    json = data;
  } else if (typeof Blob !== "undefined" && data instanceof Blob) {
    json = await data.text();
  } else if (data instanceof ArrayBuffer) {
    json = new TextDecoder().decode(data);
  } else if (ArrayBuffer.isView(data)) {
    json = new TextDecoder().decode(data);
  } else {
    return null;
  }

  try {
    return JSON.parse(json) as GeminiServerMessage;
  } catch {
    return null;
  }
}

/**
 * Small raw-WebSocket client shared conceptually with mobile.
 *
 * Raw protocol keeps the browser and React Native behavior identical while the
 * server SDK is used only for safe ephemeral-token provisioning.
 */
export class GeminiLiveClient {
  private socket: WebSocket | null = null;
  private desiredOpen = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private resumptionHandle: string | undefined;
  private resumableToken: GeminiLiveToken | undefined;
  private connectionGeneration = 0;

  constructor(
    private readonly tokenProvider: () => Promise<GeminiLiveToken>,
    private readonly callbacks: Callbacks,
  ) {}

  async start(): Promise<void> {
    if (this.desiredOpen) return;
    this.desiredOpen = true;
    this.reconnectAttempts = 0;
    await this.connect();
  }

  private async connect(): Promise<void> {
    const generation = ++this.connectionGeneration;
    this.callbacks.onState(this.reconnectAttempts > 0 ? "reconnecting" : "connecting");
    this.callbacks.onDiagnostic?.("socket.connecting");

    let provisioned: GeminiLiveToken;
    try {
      const canResume =
        Boolean(this.resumptionHandle) &&
        this.resumableToken &&
        Date.parse(this.resumableToken.expiresAt) > Date.now() + 5_000;
      if (!canResume) this.resumptionHandle = undefined;
      provisioned = canResume ? this.resumableToken! : await this.tokenProvider();
      this.resumableToken = provisioned;
      this.callbacks.onDiagnostic?.(canResume ? "token.reused" : "token.provisioned");
    } catch (error) {
      this.callbacks.onError((error as Error).message);
      throw error;
    }

    if (!this.desiredOpen || generation !== this.connectionGeneration) return;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const failSetup = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(setupTimer);
        reject(new Error(message));
      };
      const setupTimer = setTimeout(() => {
        failSetup("Gemini Live setup timed out. Please try again.");
        socket.close();
      }, SETUP_TIMEOUT_MS);
      const socket = new WebSocket(
        `${GEMINI_CONSTRAINED_WS}?access_token=${encodeURIComponent(provisioned.token)}`,
      );
      this.socket = socket;

      socket.onopen = () => {
        this.callbacks.onDiagnostic?.("socket.open");
        const sessionResumption = this.resumptionHandle
          ? { handle: this.resumptionHandle }
          : {};
        socket.send(
          JSON.stringify({
            setup: {
              ...provisioned.setup,
              sessionResumption,
            },
          }),
        );
        this.callbacks.onDiagnostic?.(
          "setup.sent",
          this.resumptionHandle ? "resuming previous Gemini session" : "new Gemini session",
        );
      };

      socket.onmessage = (event) => {
        void decodeServerMessage(event.data).then((message) => {
          if (!message) return;
          if (message.error) {
            const detail = message.error.message ?? message.error.status ?? "Unknown setup error.";
            failSetup(`Gemini Live rejected the connection: ${detail}`);
            socket.close();
            return;
          }

          if (message.setupComplete) {
            if (!settled) {
              settled = true;
              clearTimeout(setupTimer);
              this.reconnectAttempts = 0;
              this.callbacks.onDiagnostic?.("setup.complete");
              this.callbacks.onState("listening");
              resolve();
            }
          }

          const content = message.serverContent;
          if (content?.modelTurn?.parts) {
            for (const part of content.modelTurn.parts) {
              const audio = part.inlineData?.data;
              if (audio) this.callbacks.onAudio(audio);
            }
          }
          if (content?.inputTranscription?.text) {
            this.callbacks.onInputTranscript(content.inputTranscription.text);
          }
          if (content?.outputTranscription?.text) {
            this.callbacks.onOutputTranscript(content.outputTranscription.text);
          }
          if (content?.interrupted) this.callbacks.onInterrupted();
          if (content?.interrupted) this.callbacks.onDiagnostic?.("turn.interrupted");
          if (content?.turnComplete) {
            this.callbacks.onDiagnostic?.("turn.complete");
            this.callbacks.onTurnComplete();
          }

          if (message.toolCall?.functionCalls?.length) {
            this.callbacks.onDiagnostic?.(
              "tool.calls",
              message.toolCall.functionCalls.map((call) => call.name).join(","),
            );
            void this.answerToolCalls(message.toolCall.functionCalls);
          }

          const update = message.sessionResumptionUpdate;
          if (update?.resumable && update.newHandle) {
            this.resumptionHandle = update.newHandle;
          }
          if (message.goAway && this.desiredOpen) {
            this.scheduleReconnect(true);
          }
        }).catch((error) => {
          failSetup(`Could not read the Gemini Live setup response: ${(error as Error).message}`);
          socket.close();
        });
      };

      socket.onerror = () => {
        this.callbacks.onDiagnostic?.("socket.error");
        failSetup("Could not connect to Gemini Live.");
      };

      socket.onclose = (event) => {
        this.callbacks.onDiagnostic?.(
          "socket.close",
          `code=${event.code}${event.reason ? ` reason=${event.reason}` : ""}`,
        );
        failSetup(
          event.reason
            ? `Gemini Live closed before setup completed: ${event.reason}`
            : "Gemini Live closed before setup completed.",
        );
        if (this.desiredOpen && generation === this.connectionGeneration) {
          this.scheduleReconnect(false);
        }
      };
    });
  }

  private async answerToolCalls(calls: GeminiFunctionCall[]): Promise<void> {
    try {
      const functionResponses = await this.callbacks.onToolCalls(calls);
      this.send({ toolResponse: { functionResponses } });
    } catch (error) {
      this.callbacks.onError(`Voice command failed: ${(error as Error).message}`);
    }
  }

  private scheduleReconnect(closeCurrent: boolean): void {
    if (!this.desiredOpen || this.reconnectTimer) return;
    if (closeCurrent) {
      this.socket?.close();
      this.socket = null;
    }
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > 5) {
      this.callbacks.onError("Gemini Live could not reconnect.");
      this.close();
      return;
    }
    this.callbacks.onState("reconnecting");
    this.callbacks.onDiagnostic?.("socket.reconnect_scheduled", `attempt=${this.reconnectAttempts}`);
    const delay = Math.min(4_000, 500 * 2 ** (this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error) => {
        this.callbacks.onError((error as Error).message);
        this.scheduleReconnect(false);
      });
    }, delay);
  }

  sendAudio(base64Pcm: string): void {
    this.send({
      realtimeInput: {
        audio: { data: base64Pcm, mimeType: "audio/pcm;rate=16000" },
      },
    });
  }

  sendText(text: string): void {
    this.send({ realtimeInput: { text } });
  }

  endAudioStream(): void {
    this.send({ realtimeInput: { audioStreamEnd: true } });
  }

  private send(payload: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(payload));
    }
  }

  close(): void {
    this.desiredOpen = false;
    this.connectionGeneration += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close();
    this.socket = null;
    this.resumptionHandle = undefined;
    this.resumableToken = undefined;
    this.callbacks.onState("closed");
    this.callbacks.onDiagnostic?.("voice.closed");
  }
}
