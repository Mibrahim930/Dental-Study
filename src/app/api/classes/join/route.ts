import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { joinClass } from "@/lib/classes";

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const { code } = (await request.json()) as { code?: string };
  const cls = code ? joinClass(user.id, code) : null;
  if (!cls) return NextResponse.json({ error: "No class has that invite code. Check it and try again." }, { status: 404 });
  return NextResponse.json({ id: cls.id, name: cls.name });
}
