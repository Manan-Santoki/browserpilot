import type { ModelMessage } from "ai";
import type { WireFormat } from "@browserpilot/core";

/**
 * How a picture a tool took reaches the model.
 *
 * This is the reason the agent loop is ours rather than the Agent SDK's.
 *
 * Anthropic's Messages API lets a `tool_result` carry an image block, so a
 * screenshot travels attached to the call that produced it. OpenAI's format has
 * no such thing: a `tool` message is text and nothing else. Every naive bridge
 * between the two therefore drops the image silently, and the symptom is not an
 * error — it is a model that confidently describes a page it never saw.
 *
 * The fix, proven against a real provider before any of this was written, is to
 * leave a note where the image would have gone and hoist the image itself into
 * a `user` message immediately after the tool results. The model reads the two
 * together and answers from pixels.
 */

export type CapturedImage = {
  /** Which call produced it, so the note and the image can refer to each other. */
  toolName: string;
  mediaType: string;
  /** Base64, as every provider wants it. */
  data: string;
};

/** What a wrapped tool hands back to the loop. */
export type ToolOutcome = {
  /** What the model reads. Never empty — silence reads as a failed call. */
  text: string;
  image?: CapturedImage;
};

/** Stands in for the image inside a tool result that cannot carry one. */
export function imagePlaceholder(toolName: string): string {
  return `[${toolName} returned an image — it follows in the next message]`;
}

/**
 * What a blind model is told instead of being sent a picture.
 *
 * Sending one anyway is not a graceful degradation: qwen3.7-plus answers 400
 * and the whole turn dies. Saying plainly that the screenshot exists and went
 * to the person keeps the model working on the accessibility tree, which is how
 * it drives pages anyway.
 */
export function blindNote(toolName: string): string {
  return `[${toolName} captured a screenshot and showed it to the user. This model cannot read images — describe the page from the accessibility snapshot instead.]`;
}

/**
 * Shape one tool's outcome for the model, given what the model can accept.
 *
 * Returns AI SDK tool-output content parts. For Anthropic the image rides along
 * with the result; for OpenAI only the note does, and `hoistImages` carries the
 * picture.
 */
export type OutputPart =
  | { type: "text"; text: string }
  | { type: "file"; mediaType: string; data: { type: "data"; data: string } };

export function toolOutputContent(
  outcome: ToolOutcome,
  format: WireFormat,
  vision: boolean,
): OutputPart[] {
  const { text, image } = outcome;
  if (!image) return [{ type: "text", text }];
  if (!vision) return [{ type: "text", text: `${text}\n${blindNote(image.toolName)}` }];

  if (format === "anthropic") {
    return [
      { type: "text", text },
      { type: "file", mediaType: image.mediaType, data: { type: "data", data: image.data } },
    ];
  }

  return [{ type: "text", text: `${text}\n${imagePlaceholder(image.toolName)}` }];
}

/**
 * Append the images a step's tools produced, as a message the model can read.
 *
 * Only ever called for providers whose tool results cannot carry an image. The
 * text part matters as much as the image: without it the message is a bare
 * picture with no stated relationship to the call above it, and models answer
 * about the wrong thing.
 */
export function hoistImages(messages: ModelMessage[], images: CapturedImage[]): ModelMessage[] {
  if (images.length === 0) return messages;

  return [
    ...messages,
    {
      role: "user",
      content: [
        {
          type: "text",
          text:
            images.length === 1
              ? `Image returned by ${images[0]!.toolName}:`
              : `Images returned by ${images.map((i) => i.toolName).join(", ")}:`,
        },
        ...images.map((image) => ({
          type: "file" as const,
          mediaType: image.mediaType,
          data: image.data,
        })),
      ],
    },
  ];
}

/**
 * Whether this provider needs the hoist at all.
 *
 * Kept as a named question rather than an inline comparison because it is the
 * one branch in the engine that decides whether screenshots work.
 */
export function needsImageHoist(format: WireFormat): boolean {
  return format === "openai";
}
