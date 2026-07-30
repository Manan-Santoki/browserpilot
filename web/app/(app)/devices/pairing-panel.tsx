"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { createPairingCode, type PairingState } from "./actions";

type PairingStatus = {
  status: "pending" | "connected" | "expired";
  deviceName?: string;
};

export function PairingPanel() {
  const router = useRouter();
  const [state, setState] = useState<PairingState | null>(null);
  const [pairingStatus, setPairingStatus] = useState<PairingStatus | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [pending, setPending] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const refreshedCodeRef = useRef<string | null>(null);

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

  useEffect(() => {
    const code = state?.code;
    if (!code) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const res = await fetch(`/api/pair/status?code=${encodeURIComponent(code)}`, {
          cache: "no-store",
        });
        if (!res.ok) throw new Error("Could not check the pairing code");

        const next = (await res.json()) as PairingStatus;
        if (cancelled) return;
        setPairingStatus(next);

        if (next.status === "connected") {
          if (refreshedCodeRef.current !== code) {
            refreshedCodeRef.current = code;
            router.refresh();
          }
          return;
        }
        if (next.status === "expired") return;
      } catch {
        // A transient polling failure should not invalidate a code that may
        // still be visible and usable. Try again until its own timer expires.
      }

      if (!cancelled) timer = setTimeout(poll, 1_000);
    };

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [router, state?.code]);

  const generate = async () => {
    setPending(true);
    setPairingStatus(null);
    refreshedCodeRef.current = null;
    try {
      const next = await createPairingCode();
      setState(next);
      setPairingStatus(next.code ? { status: "pending" } : null);
    } finally {
      setPending(false);
    }
  };

  const connected = pairingStatus?.status === "connected";
  const expired =
    state?.code &&
    !connected &&
    (secondsLeft === 0 || pairingStatus?.status === "expired");

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
      ) : connected ? (
        <div className="flex items-center gap-3 py-2">
          <CheckCircle2 className="size-8 text-emerald-500" aria-hidden />
          <div>
            <p className="font-medium">Device connected</p>
            <p className="text-muted-foreground text-sm">
              {pairingStatus.deviceName
                ? `${pairingStatus.deviceName} can now reach your BrowserPilot sessions.`
                : "This device can now reach your BrowserPilot sessions."}
            </p>
          </div>
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
