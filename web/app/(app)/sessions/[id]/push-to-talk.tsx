"use client";

import { useEffect, useRef, useState } from "react";

type Props = {
  language: string;
  disabled?: boolean;
  /** Called with the transcript so the caller can put it in the composer. */
  onTranscript: (text: string) => void;
};

const LANGUAGES = [
  { code: "auto", label: "Auto" },
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी" },
  { code: "gu", label: "ગુજરાતી" },
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
      <button
        type="button"
        onClick={recording ? stop : start}
        disabled={disabled || busy}
        aria-label={recording ? "Stop recording" : "Start recording"}
        title={recording ? "Stop and transcribe" : "Hold a thought — tap to record"}
        className={`rounded-md border px-2.5 py-2 text-sm transition-colors disabled:opacity-40 ${
          recording
            ? "animate-pulse border-red-400 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-950/40 dark:text-red-300"
            : "border-neutral-300 hover:bg-neutral-50 dark:border-neutral-600 dark:hover:bg-neutral-900"
        }`}
      >
        {busy ? "…" : recording ? "■" : "🎤"}
      </button>

      <select
        value={lang}
        onChange={(e) => setLang(e.target.value)}
        aria-label="Speech language"
        className="rounded-md border border-neutral-300 bg-white px-1.5 py-1.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>

      {error ? (
        <span role="alert" className="text-xs text-red-600 dark:text-red-400">
          {error}
        </span>
      ) : null}
    </div>
  );
}
