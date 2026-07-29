"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2Icon, MicIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Props = {
  language: string;
  disabled?: boolean;
  /** Called with the transcript so the caller can put it in the composer. */
  onTranscript: (text: string) => void;
};

const LANGUAGES = [
  { value: "auto", label: "Auto" },
  { value: "en", label: "English" },
  { value: "hi", label: "हिन्दी" },
  { value: "gu", label: "ગુજરાતી" },
];

/**
 * Push-to-talk. The transcript lands in the composer for the user to read and
 * edit before sending — it is never dispatched to the agent automatically,
 * because a misheard word here becomes a click in a real application.
 */
export function PushToTalk({ language, disabled, onTranscript }: Props) {
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState(language || "auto");

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  useEffect(() => {
    return () => {
      recorderRef.current?.stream.getTracks().forEach((t) => t.stop());
    };
  }, []);

  const start = async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
        if (blob.size === 0) return;

        setBusy(true);
        try {
          const form = new FormData();
          form.append("audio", new File([blob], "speech.webm", { type: blob.type }));
          if (lang !== "auto") form.append("language", lang);

          const res = await fetch("/api/transcribe", { method: "POST", body: form });
          const body = (await res.json()) as { text?: string; error?: string };

          if (!res.ok || !body.text) {
            setError(body.error ?? "Could not transcribe that.");
          } else {
            onTranscript(body.text);
          }
        } catch {
          setError("Could not reach the transcription service.");
        } finally {
          setBusy(false);
        }
      };

      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setError("Microphone permission was refused.");
    }
  };

  const stop = () => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  return (
    <div className="flex items-center gap-2">
      <Button
        type="button"
        variant={recording ? "destructive" : "outline"}
        size="icon"
        onClick={recording ? stop : start}
        disabled={disabled || busy}
        aria-label={recording ? "Stop recording" : "Start recording"}
        title={recording ? "Stop and transcribe" : "Tap to record, tap again to stop"}
        className={recording ? "animate-pulse" : undefined}
      >
        {busy ? (
          <Loader2Icon className="animate-spin" />
        ) : recording ? (
          <SquareIcon />
        ) : (
          <MicIcon />
        )}
      </Button>

      <Select
        value={lang}
        onValueChange={(v) => setLang(v ?? "auto")}
        items={LANGUAGES}
      >
        <SelectTrigger size="sm" className="w-[104px]" aria-label="Speech language">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LANGUAGES.map((l) => (
            <SelectItem key={l.value} value={l.value}>
              {l.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {error ? (
        <span role="alert" className="text-destructive text-xs">
          {error}
        </span>
      ) : null}
    </div>
  );
}
