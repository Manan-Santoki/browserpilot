"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
    <Card className="p-5">
      {!state?.code ? (
        <div className="space-y-3">
          <p className="text-sm text-foreground/90">
            Generate a code, then scan it with the BrowserPilot app. The code works once and
            expires in five minutes.
          </p>
          <Button onClick={generate} disabled={pending}>
            {pending ? "Generating…" : "Show pairing code"}
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-6">
          <div className={expired ? "opacity-30" : ""}>
            <canvas ref={canvasRef} className="rounded bg-white p-2" /* white by necessity: scanners need the contrast */ />
          </div>

          <div className="space-y-2">
            <p className="text-signal font-mono text-2xl tracking-[0.2em]">{state.code}</p>
            <p className="text-sm text-muted-foreground">
              {expired
                ? "This code has expired."
                : `Expires in ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")}`}
            </p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Scan the code, or type it into the app if the camera will not cooperate.
            </p>
            <button
              onClick={generate}
              disabled={pending}
              className="text-muted-foreground text-sm underline-offset-4 hover:underline dark:text-muted-foreground"
            >
              Generate a new code
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
