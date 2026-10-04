import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { createClass } from "@/lib/classes";

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const { name } = (await request.json()) as { name?: string };
  if (!name?.trim()) return NextResponse.json({ error: "Give the class a name." }, { status: 400 });
  return NextResponse.json({ id: createClass(user.id, name.trim().slice(0, 80)) });
}
