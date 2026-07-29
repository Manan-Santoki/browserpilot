"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { createPairingCode, type PairingState } from "./actions";

export function PairingPanel() {
  const [state, setState] = useState<PairingState | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [pending, setPending] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    if (!state?.code || !canvasRef.current) return;
    // The QR carries the code and where to redeem it, so the app needs no
    // configuration beyond a camera.
    const payload = JSON.stringify({
      v: 1,
      code: state.code,
      url: `${window.location.origin}/api/pair`,
    });
    void QRCode.toCanvas(canvasRef.current, payload, { width: 220, margin: 1 });
  }, [state?.code]);

  useEffect(() => {
    if (!state?.expiresAt) return;
    const tick = () => {
      const remaining = Math.max(
        0,
        Math.round((new Date(state.expiresAt!).getTime() - Date.now()) / 1000),
      );
      setSecondsLeft(remaining);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [state?.expiresAt]);

  const generate = async () => {
    setPending(true);
    try {
      setState(await createPairingCode());
    } finally {
      setPending(false);
    }
  };

  const expired = state?.code && secondsLeft === 0;

  return (
    <section className="rounded-lg border border-neutral-200 p-5 dark:border-neutral-800">
      {!state?.code ? (
        <div className="space-y-3">
          <p className="text-sm text-neutral-600 dark:text-neutral-300">
            Generate a code, then scan it with the BrowserPilot app. The code works once and
            expires in five minutes.
          </p>
          <button
            onClick={generate}
            disabled={pending}
            className="rounded-md bg-neutral-900 px-3 py-2 text-sm font-medium text-white disabled:opacity-50 dark:bg-white dark:text-neutral-900"
          >
            {pending ? "Generating…" : "Show pairing code"}
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          <div className={expired ? "opacity-30" : ""}>
            <canvas ref={canvasRef} className="rounded bg-white p-2" />
          </div>

          <div className="space-y-2">
            <p className="font-mono text-2xl tracking-[0.2em]">{state.code}</p>
            <p className="text-sm text-neutral-500 dark:text-neutral-400">
              {expired
                ? "This code has expired."
                : `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`}
            </p>
            <p className="max-w-xs text-xs text-neutral-500 dark:text-neutral-400">
              Scan the code, or type it into the app if the camera will not cooperate.
            </p>
            <button
              onClick={generate}
              disabled={pending}
              className="text-sm text-neutral-500 underline-offset-4 hover:underline dark:text-neutral-400"
            >
              Generate a new code
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
