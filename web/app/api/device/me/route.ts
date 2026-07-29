import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";

/** Who the caller is. The app shows this so a shared phone is never ambiguous. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Not signed in" }, { status: 401 });
  return NextResponse.json({ user });
}
