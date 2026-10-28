import { NextResponse } from "next/server";
import { apiAdmin, unauthorized } from "@/lib/user";
import { scanLessonsForFiller } from "@/lib/study";

/** The owner asks for every stored lesson to be checked for filler now (no AI call); the Admin page shows the result. */
export async function POST() {
  const admin = await apiAdmin();
  if (!admin) return unauthorized();
  const scan = scanLessonsForFiller();
  return NextResponse.json({ ok: true, checked: scan.checked, found: scan.found.length });
}
