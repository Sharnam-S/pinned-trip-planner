import { NextResponse } from "next/server";
import { authEnabled, getSessionUser } from "@/lib/auth";

export const runtime = "nodejs";

/**
 * Who am I? `enabled: false` means this deploy has no auth configured — the
 * client then keeps the original single-user, localStorage-only behavior.
 */
export async function GET() {
  if (!authEnabled()) return NextResponse.json({ enabled: false, user: null });
  const user = await getSessionUser();
  return NextResponse.json({ enabled: true, user });
}
