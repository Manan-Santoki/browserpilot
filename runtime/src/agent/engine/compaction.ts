import type { ModelMessage } from "ai";

/**
 * Keep a long session inside the model's context window.
 *
 * This is the one service the Agent SDK performed for free that we now owe
 * ourselves. A BrowserPilot session is unusually lopsided: a handful of short
 * sentences from a person, and a great many accessibility snapshots, each of
 * which can be tens of thousands of tokens and none of which is read twice
 * once the agent has moved to the next page.
 *
 * So the strategy is not "summarise the conversation". It is: throw away the
 * bulky evidence the agent has already acted on, keep every word anyone
 * actually said, and keep the most recent evidence intact because that is what
 * the current step is reasoning about.
 */

/** Roughly four characters per token. Wrong in detail, right in scale. */
export function estimateTokens(messages: ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4);
}

export type CompactionOptions = {
  /** Compact once the transcript passes this many estimated tokens. */
  threshold: number;
  /** Tool results this recent are never touched. */
  keepRecentToolResults: number;
  /** How much of a replaced tool result to leave behind. */
  summaryLength: number;
};

export const DEFAULT_COMPACTION: CompactionOptions = {
  // Comfortably inside the smallest context window we offer while leaving room
  // for a large snapshot plus a reply.
  threshold: 120_000,
  keepRecentToolResults: 6,
  summaryLength: 400,
};

function isToolMessage(message: ModelMessage): boolean {
  return message.role === "tool";
}

/**
 * Replace an old tool result with its opening lines.
 *
 * Truncated rather than removed: a tool message must stay paired with the
 * assistant tool call above it or the transcript stops being a valid
 * conversation, and providers reject it outright. The remaining text also
 * keeps the agent's own history readable — "I looked at the orders page and
 * saw…" is still supportable from the first few hundred characters.
 */
function shrink(message: ModelMessage, summaryLength: number): ModelMessage {
  if (message.role !== "tool" || !Array.isArray(message.content)) return message;

  return {
    ...message,
    content: message.content.map((part) => {
      if (part.type !== "tool-result") return part;

      const output = part.output;
      if (!output) return part;

      // An error is already short and is the one thing the agent most needs to
      // re-read; a denial carries no payload at all.
      if (
        output.type === "error-text" ||
        output.type === "error-json" ||
        output.type === "execution-denied"
      ) {
        return part;
      }

      const rendered =
        output.type === "text"
          ? output.value
          : output.type === "content"
            ? output.value.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n")
            : JSON.stringify(output.value);

      if (rendered.length <= summaryLength) return part;

      return {
        ...part,
        output: {
          type: "text" as const,
          value: `${rendered.slice(0, summaryLength)}\n…[trimmed: this page has been read and acted on already]`,
        },
      };
    }),
  };
}

/**
 * Shrink the transcript if it has grown too large, otherwise leave it alone.
 *
 * Returns the same array when nothing was done, so a caller can tell whether
 * compaction happened without comparing contents.
 */
export function compact(
  messages: ModelMessage[],
  options: CompactionOptions = DEFAULT_COMPACTION,
): ModelMessage[] {
  if (estimateTokens(messages) <= options.threshold) return messages;

  // Index the tool messages from the end, so "recent" means recent in the
  // conversation rather than recent in the array of all messages.
  const toolIndexes = messages
    .map((message, index) => (isToolMessage(message) ? index : -1))
    .filter((index) => index >= 0);
  const protectedFrom = toolIndexes.at(-options.keepRecentToolResults) ?? Infinity;

  return messages.map((message, index) =>
    index < protectedFrom ? shrink(message, options.summaryLength) : message,
  );
}
