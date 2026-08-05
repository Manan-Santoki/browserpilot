"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The browser beside the conversation, with a handle between them.
 *
 * Both panels can be collapsed, because which one matters changes with the
 * task: filling in a long form you want the browser; reading back what the
 * robot decided you want the conversation. Previously only the chat could be
 * hidden, and the button to do it lived in the *browser's* header.
 *
 * The chat is clamped between a readable minimum and half the width. Past half
 * the browser stops being a preview and starts being a thumbnail, which is the
 * one thing this page cannot afford to become.
 */

const MIN_CHAT_PX = 320;
const MAX_CHAT_FRACTION = 0.5;
const STORAGE_KEY = "bp.split.chat-px";

type Collapsed = "none" | "chat" | "browser";

export function SplitPane({ browser, chat }: { browser: ReactNode; chat: ReactNode }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [chatPx, setChatPx] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState<Collapsed>("none");
  const [dragging, setDragging] = useState(false);

  // Read once on mount rather than during render: the server has no
  // localStorage, and reading it in render makes the first paint disagree with
  // the server's and hydrate badly.
  useEffect(() => {
    const saved = Number(window.localStorage.getItem(STORAGE_KEY));
    setChatPx(Number.isFinite(saved) && saved > 0 ? saved : MIN_CHAT_PX);
  }, []);

  const clamp = useCallback((px: number) => {
    const total = containerRef.current?.clientWidth ?? 0;
    if (total === 0) return px;
    return Math.min(Math.max(px, MIN_CHAT_PX), Math.round(total * MAX_CHAT_FRACTION));
  }, []);

  /**
   * Track the pointer on the window, not on the handle.
   *
   * The handle moves as the split changes, so listening on it means chasing
   * the thing you are dragging: the first move lands, the element shifts out
   * from under the cursor, and the rest are delivered somewhere else. The
   * window does not move.
   */
  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (collapsed !== "none") return;
    event.preventDefault();
    setDragging(true);

    const move = (e: PointerEvent) => {
      e.preventDefault();
      const right = containerRef.current?.getBoundingClientRect().right ?? 0;
      setChatPx(clamp(right - e.clientX));
    };
    const end = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      setChatPx((px) => {
        if (px !== null) window.localStorage.setItem(STORAGE_KEY, String(px));
        return px;
      });
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  };

  /** Keyboard resizing, because a drag handle nobody can reach is decoration. */
  const nudge = (event: React.KeyboardEvent) => {
    const step = event.shiftKey ? 64 : 16;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setChatPx((px) => clamp((px ?? MIN_CHAT_PX) + step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setChatPx((px) => clamp((px ?? MIN_CHAT_PX) - step));
    }
  };

  const width = collapsed === "chat" ? 0 : (chatPx ?? MIN_CHAT_PX);

  return (
    <div
      ref={containerRef}
      className={cn(
        "flex min-h-0 flex-1 flex-col gap-4 lg:min-h-[480px] lg:flex-row lg:gap-0",
        // A drag that selects the transcript behind it reads as a broken drag.
        dragging && "cursor-col-resize select-none [&_*]:pointer-events-none",
      )}
    >
      {/* Below lg the two stack, browser first: on a phone you scroll to the
          conversation, you do not hunt for the screen. */}
      <div
        className={cn(
          "order-1 flex min-h-0 min-w-0 flex-col max-lg:h-auto",
          collapsed === "browser" ? "lg:hidden" : "flex-1",
        )}
      >
        {browser}
      </div>

      <Handle
        collapsed={collapsed}
        dragging={dragging}
        onPointerDown={startDrag}
        onKeyDown={nudge}
        onToggle={(which) => setCollapsed((c) => (c === which ? "none" : which))}
        chatPx={width}
      />

      <div
        className={cn(
          "order-2 flex min-h-0 min-w-0 flex-col max-lg:h-auto",
          collapsed === "chat" ? "lg:hidden" : "",
          collapsed === "browser" ? "lg:flex-1" : "",
        )}
        style={
          collapsed === "none" && chatPx !== null
            ? { flex: `0 0 ${chatPx}px` }
            : undefined
        }
      >
        {chat}
      </div>
    </div>
  );
}

/**
 * The divider: a drag target, and the only place either panel is collapsed
 * from. Putting both controls on the seam is what makes it obvious they are
 * two halves of one decision.
 */
function Handle({
  collapsed,
  dragging,
  chatPx,
  onPointerDown,
  onKeyDown,
  onToggle,
}: {
  collapsed: Collapsed;
  dragging: boolean;
  chatPx: number;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onKeyDown: (event: React.KeyboardEvent) => void;
  onToggle: (which: Collapsed) => void;
}) {
  return (
    <div className="relative order-1 hidden w-4 shrink-0 lg:flex lg:items-center lg:justify-center">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the conversation"
        aria-valuenow={chatPx}
        tabIndex={collapsed === "none" ? 0 : -1}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className={cn(
          "focus-visible:bg-signal group absolute inset-y-0 left-1/2 w-1 -translate-x-1/2 rounded-full outline-none transition-colors",
          collapsed === "none" ? "hover:bg-signal/60 cursor-col-resize" : "cursor-default",
          dragging ? "bg-signal" : "bg-transparent",
        )}
      />

      {/* Pinned to the top of the seam, level with the two panel headers.
          Centring them vertically put the controls halfway down a very tall
          column, nowhere near anything they act on. */}
      <div className="pointer-events-none absolute top-2.5 left-1/2 flex -translate-x-1/2 flex-col gap-1">
        <CollapseButton
          label={collapsed === "browser" ? "Show the browser" : "Hide the browser"}
          onClick={() => onToggle("browser")}
          icon={collapsed === "browser" ? <ChevronRightIcon /> : <ChevronLeftIcon />}
        />
        <CollapseButton
          label={collapsed === "chat" ? "Show the conversation" : "Hide the conversation"}
          onClick={() => onToggle("chat")}
          icon={collapsed === "chat" ? <ChevronLeftIcon /> : <ChevronRightIcon />}
        />
      </div>
    </div>
  );
}

function CollapseButton({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-ring bg-background border-border pointer-events-auto flex size-5 items-center justify-center rounded border transition-colors focus-visible:ring-2 focus-visible:outline-none [&_svg]:size-3"
    >
      {icon}
    </button>
  );
}
