import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { dueCards, countDue } from "@/lib/practice";
import { parseNotes } from "@/lib/processing";

export async function GET(request: Request) {
  const limit = Math.min(Number(new URL(request.url).searchParams.get("limit") ?? 20), 200);
  const cards = dueCards(limit).map((q) => ({
    card_id: q.card_id,
    id: q.id,
    type: q.type,
    patient_box: q.patient_box ? JSON.parse(q.patient_box) : null,
    stem: q.stem,
    options: JSON.parse(q.options),
    correct_index: q.correct_index,
    explanation: q.explanation,
    image: imageFor(q.image_page_id),
    source_page_id: q.source_page_id,
  }));
  return NextResponse.json({ due: countDue(), cards });
}

function imageFor(pageId: number | null) {
  if (!pageId) return null;
  const p = db.prepare("SELECT notes_json, aspect FROM pages WHERE id = ?").get(pageId) as { notes_json: string | null; aspect: number } | undefined;
  return p ? { page_id: pageId, aspect: p.aspect, crop: parseNotes(p)?.case_image_box ?? null } : null;
}
