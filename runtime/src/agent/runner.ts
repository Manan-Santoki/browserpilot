import {
  query,
  type Options,
  type PermissionResult,
  type Query,
} from "@anthropic-ai/claude-agent-sdk";
import { classifyToolUse } from "./policy";
import { buildSystemPrompt } from "./prompt";
import type { RobotEvent } from "../session/events";

export type QueryFn = (params: { prompt: AsyncIterable<never>; options?: Options }) => Query;

export type StartAgentOptions = {
  cdpEndpoint: string;
  jwmUrl: string;
  model: string;
  env: Record<string, string>;
  onEvent: (event: RobotEvent) => void;
};

export type StartAgentDeps = {
  queryFn?: QueryFn;
};

export type AgentRunner = {
  send(text: string): void;
  approve(requestId: string, approved: boolean): void;
  stop(): Promise<void>;
};

/** Async queue that turns runner.send() calls into the SDK's streaming input. */
function createInputStream() {
  const pending: string[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;

  return {
    push(text: string) {
      pending.push(text);
      waiters.splice(0).forEach((wake) => wake());
    },
    close() {
      closed = true;
      waiters.splice(0).forEach((wake) => wake());
    },
    async *stream(): AsyncGenerator<unknown> {
      for (;;) {
        const text = pending.shift();
        if (text !== undefined) {
          yield {
            type: "user",
            message: { role: "user", content: text },
            parent_tool_use_id: null,
            session_id: "",
          };
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
    },
  };
}

function shortToolName(name: string): string {
  return name.replace(/^mcp__playwright__/, "");
}

function summarize(toolName: string, input: Record<string, unknown>): string {
  const short = shortToolName(toolName);
  const target = typeof input.element === "string" ? input.element : undefined;
  const url = typeof input.url === "string" ? input.url : undefined;
  if (url) return `${short}: ${url}`;
  if (target) return `${short}: ${target}`;
  return short;
}

export async function startAgent(
  opts: StartAgentOptions,
  deps: StartAgentDeps = {},
): Promise<AgentRunner> {
  const queryFn = deps.queryFn ?? (query as unknown as QueryFn);
  const input = createInputStream();
  const approvals = new Map<string, (approved: boolean) => void>();
  let nextRequestId = 0;

  const canUseTool = async (
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<PermissionResult> => {
    if (classifyToolUse(toolName, toolInput) === "auto") {
      return { behavior: "allow", updatedInput: toolInput };
    }

    const requestId = `apr_${++nextRequestId}`;
    opts.onEvent({
      type: "approval_request",
      requestId,
      tool: shortToolName(toolName),
      summary: summarize(toolName, toolInput),
    });

    const approved = await new Promise<boolean>((resolve) => {
      approvals.set(requestId, resolve);
    });
    approvals.delete(requestId);
    opts.onEvent({ type: "approval_resolved", requestId, approved });

    return approved
      ? { behavior: "allow", updatedInput: toolInput }
      : { behavior: "deny", message: "The user declined this action." };
  };

  const options: Options = {
    model: opts.model,
    env: opts.env,
    systemPrompt: buildSystemPrompt(opts.jwmUrl),
    strictMcpConfig: true,
    permissionMode: "default",
    mcpServers: {
      playwright: {
        type: "stdio",
        command: "bunx",
        args: ["@playwright/mcp@latest", "--cdp-endpoint", opts.cdpEndpoint, "--caps", "pdf"],
        alwaysLoad: true,
      },
    },
    canUseTool,
  };

  const session = queryFn({ prompt: input.stream() as AsyncIterable<never>, options });

  // Pump SDK messages into RobotEvents. Runs until the query closes.
  void (async () => {
    try {
      for await (const message of session as AsyncIterable<unknown>) {
        const msg = message as {
          type: string;
          message?: { content?: Array<Record<string, unknown>> };
        };
        if (msg.type !== "assistant") continue;
        for (const block of msg.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            opts.onEvent({ type: "agent_text", text: block.text });
          } else if (block.type === "tool_use" && typeof block.name === "string") {
            const toolInput = (block.input ?? {}) as Record<string, unknown>;
            opts.onEvent({
              type: "tool_activity",
              tool: shortToolName(block.name),
              summary: summarize(block.name, toolInput),
            });
          }
        }
      }
    } catch (error) {
      opts.onEvent({ type: "error", message: (error as Error).message });
    }
  })();

  return {
    send(text: string) {
      input.push(text);
    },
    approve(requestId: string, approved: boolean) {
      approvals.get(requestId)?.(approved);
    },
    async stop() {
      approvals.forEach((resolve) => resolve(false));
      approvals.clear();
      input.close();
      await session.interrupt().catch(() => {});
      session.close();
    },
  };
}
