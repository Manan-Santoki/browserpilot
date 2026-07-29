"use client";

import { useCallback, useImperativeHandle, useRef, useState } from "react";
import { cn } from "@/lib/utils";

export type BrowserStreamHandle = {
  /** Hand over a frame as it arrives. Stale frames are dropped, not queued. */
  push(blob: Blob): void;
};

type Props = {
  ref?: React.Ref<BrowserStreamHandle>;
  /** Shown until the first frame arrives. */
  placeholder?: React.ReactNode;
  /** Applied to the canvas, which keeps the frame's aspect ratio on its own. */
  canvasClassName?: string;
  className?: string;
};

/**
 * Paints the live browser stream.
 *
 * Frames arrive as JPEG blobs a dozen times a second. The obvious approach —
 * an object URL per frame swapped into an <img> — leaks unless every URL is
 * revoked, and flashes between frames because the browser tears down one decode
 * before the next is ready. Decoding to an ImageBitmap and drawing it keeps a
 * single surface on screen throughout, and frees each frame once it is drawn.
 *
 * Decoding is asynchronous and the stream does not wait, so only the newest
 * frame is kept: anything older is already wrong by the time it would appear.
 */
export function BrowserStream({ ref, placeholder, canvasClassName, className }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hasFrame, setHasFrame] = useState(false);

  const queued = useRef<Blob | null>(null);
  const decoding = useRef(false);

  const drain = useCallback(async () => {
    if (decoding.current) return;
    decoding.current = true;
    try {
      for (;;) {
        const blob = queued.current;
        queued.current = null;
        if (!blob) return;

        const bitmap = await createImageBitmap(blob);
        const canvas = canvasRef.current;
        if (!canvas) {
          bitmap.close();
          return;
        }

        // Resizing clears the canvas, so only do it when the frame really is a
        // different size — otherwise every frame would flash through blank.
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
        bitmap.close();
        setHasFrame(true);
      }
    } catch {
      // A truncated frame is not worth reporting — the next one redraws.
    } finally {
      decoding.current = false;
    }
  }, []);

  const push = useCallback(
    (blob: Blob) => {
      queued.current = blob;
      void drain();
    },
    [drain],
  );

  useImperativeHandle(ref, () => ({ push }), [push]);

  return (
    <div className={cn("relative flex items-center justify-center overflow-hidden", className)}>
      <canvas
        ref={canvasRef}
        aria-label="Live browser"
        // h/w-full with object-contain scales the frame *up* to fill the panel
        // as well as down. max-* alone only ever shrinks, which left a small
        // picture floating in the middle of a large box.
        className={cn(
          "h-full w-full object-contain",
          !hasFrame && "invisible",
          canvasClassName,
        )}
      />
      {!hasFrame && placeholder ? (
        <div className="text-muted-foreground absolute inset-0 flex items-center justify-center px-6 text-center text-sm">
          {placeholder}
        </div>
      ) : null}
    </div>
  );
}
