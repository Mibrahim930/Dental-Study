import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { joinClass } from "@/lib/classes";
import { readJson } from "@/lib/http";

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const cls = joinClass(user.id, (await readJson(request)).code);
  if (!cls) return NextResponse.json({ error: "No class has that invite code. Check it and try again." }, { status: 404 });
  return NextResponse.json({ id: cls.id, name: cls.name });
}
