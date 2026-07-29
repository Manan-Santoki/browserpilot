import type { Page } from "playwright";

/**
 * Forwards a person's clicks and keystrokes into the server-side browser.
 *
 * The preview is a scaled JPEG stream, so a click at (x, y) in the browser tab
 * is not a click at (x, y) in the page — every coordinate arrives normalised to
 * the frame the user actually saw and is scaled back to the real viewport here.
 *
 * Nothing on this path is recorded. These events carry passwords and one-time
 * codes; they are dispatched to Chromium and forgotten, and never reach the
 * transcript, the event log, or the audit trail.
 */

export type PointerInput = {
  kind: "mouse";
  action: "move" | "down" | "up" | "wheel";
  /** Fraction of the viewport, 0–1, so the client's scale never matters. */
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
};

export type KeyInput = {
  kind: "key";
  action: "down" | "up" | "char";
  key?: string;
  code?: string;
  text?: string;
  modifiers?: number;
};

/** A pasted string, inserted as one edit rather than synthesised keystrokes. */
export type TextInput = {
  kind: "text";
  text: string;
};

export type RemoteInput = PointerInput | KeyInput | TextInput;

export type InputSink = {
  dispatch(event: RemoteInput): Promise<void>;
  close(): void;
};

/**
 * Chromium acts on a key by its virtual key code, not by its name. Without
 * these, Enter submits nothing, Backspace deletes nothing, and Tab moves
 * nowhere — the events arrive and are quietly ignored.
 */
const VIRTUAL_KEY_CODES: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  CapsLock: 20,
  Escape: 27,
  " ": 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
};

/**
 * Punctuation keys have their own codes that have nothing to do with the
 * character they produce. Reading the code point instead is how "." — ASCII
 * 46, which is also the code for Delete — deleted the character to its right
 * rather than typing a full stop.
 */
const PUNCTUATION_KEY_CODES: Record<string, number> = {
  ";": 186, ":": 186,
  "=": 187, "+": 187,
  ",": 188, "<": 188,
  "-": 189, _: 189,
  ".": 190, ">": 190,
  "/": 191, "?": 191,
  "`": 192, "~": 192,
  "[": 219, "{": 219,
  "\\": 220, "|": 220,
  "]": 221, "}": 221,
  "'": 222, '"': 222,
};

function virtualKeyCode(key?: string): number | undefined {
  if (!key) return undefined;

  const named = VIRTUAL_KEY_CODES[key];
  if (named !== undefined) return named;

  const punctuation = PUNCTUATION_KEY_CODES[key];
  if (punctuation !== undefined) return punctuation;

  // Letters and digits alone share their code point with their key code.
  if (/^[a-zA-Z0-9]$/.test(key)) return key.toUpperCase().charCodeAt(0);

  // Anything else — accented characters, symbols from another layout — is
  // typed by its text rather than by a key press it may not have.
  return undefined;
}

/** Ignore anything that is not a finite fraction of the viewport. */
function fraction(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

export async function createInputSink(page: Page): Promise<InputSink> {
  const client = await page.context().newCDPSession(page);
  let closed = false;

  async function viewport(): Promise<{ width: number; height: number }> {
    const size = page.viewportSize();
    return size ?? { width: 1280, height: 800 };
  }

  return {
    async dispatch(event) {
      if (closed) return;

      if (event.kind === "text") {
        if (!event.text) return;
        // Capped: a paste is a convenience, not a channel for a megabyte.
        await client.send("Input.insertText", { text: event.text.slice(0, 10_000) });
        return;
      }

      if (event.kind === "mouse") {
        const fx = fraction(event.x);
        const fy = fraction(event.y);
        if (fx === null || fy === null) return;

        const { width, height } = await viewport();
        const x = Math.round(fx * width);
        const y = Math.round(fy * height);

        if (event.action === "wheel") {
          await client.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x,
            y,
            deltaX: event.deltaX ?? 0,
            deltaY: event.deltaY ?? 0,
          });
          return;
        }

        const type =
          event.action === "move"
            ? "mouseMoved"
            : event.action === "down"
              ? "mousePressed"
              : "mouseReleased";

        await client.send("Input.dispatchMouseEvent", {
          type,
          x,
          y,
          button: event.button ?? "left",
          // Chromium needs a button count on press and release or the page
          // sees a move; a plain move must report none.
          clickCount: event.action === "move" ? 0 : (event.clickCount ?? 1),
          buttons: event.action === "down" ? 1 : 0,
        });
        return;
      }

      if (event.action === "char") {
        if (!event.text) return;
        await client.send("Input.dispatchKeyEvent", { type: "char", text: event.text });
        return;
      }

      const code = virtualKeyCode(event.key);

      await client.send("Input.dispatchKeyEvent", {
        type: event.action === "down" ? "keyDown" : "keyUp",
        key: event.key,
        code: event.code,
        // Printable keys need text on keyDown or the character never lands.
        text: event.action === "down" ? event.text : undefined,
        // Chromium reads these, not `key`, when deciding what a press does.
        windowsVirtualKeyCode: code,
        nativeVirtualKeyCode: code,
        modifiers: event.modifiers ?? 0,
      });
    },

    close() {
      closed = true;
      void client.detach().catch(() => {});
    },
  };
}
