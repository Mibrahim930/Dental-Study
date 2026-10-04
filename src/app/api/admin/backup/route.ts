import { NextResponse } from "next/server";
import { backupConfigured, runBackup } from "@/lib/backup";
import { apiAdmin, unauthorized } from "@/lib/user";

export const maxDuration = 300;

export async function POST() {
  if (!(await apiAdmin())) return unauthorized();
  if (!backupConfigured()) return NextResponse.json({ ok: false, message: "Backups aren't configured (BACKUP_S3_* variables)." });
  return NextResponse.json(await runBackup());
}
