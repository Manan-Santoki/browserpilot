import { NextResponse } from "next/server";
import Groq from "groq-sdk";
import { getCurrentUser } from "@/lib/session";

/**
 * Transcribe a push-to-talk recording.
 *
 * The audio goes console → Groq and never reaches the runtime or the agent:
 * what the agent receives is text the user has already seen and confirmed.
 * That matters more here than in a chat app, because these words become clicks.
 */
export const runtime = "nodejs";

const SUPPORTED = new Set(["en", "hi", "gu"]);
const MAX_BYTES = 20 * 1024 * 1024;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Voice input is not configured on this server." },
      { status: 501 },
    );
  }

  const form = await req.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof File)) {
    return NextResponse.json({ error: "No audio received" }, { status: 400 });
  }
  if (audio.size > MAX_BYTES) {
    return NextResponse.json({ error: "That recording is too long." }, { status: 413 });
  }

  const requested = String(form?.get("language") ?? "").trim();
  // "auto" is expressed by omitting the parameter, which lets Whisper detect.
  const language = SUPPORTED.has(requested) ? requested : undefined;

  try {
    const groq = new Groq({ apiKey });
    const result = await groq.audio.transcriptions.create({
      file: audio,
      model: "whisper-large-v3-turbo",
      ...(language ? { language } : {}),
    });

    return NextResponse.json({ text: result.text.trim() });
  } catch (error) {
    return NextResponse.json(
      { error: `Could not transcribe that: ${(error as Error).message}` },
      { status: 502 },
    );
  }
}
