import { NextResponse } from "next/server";
import { apiUser, unauthorized } from "@/lib/user";
import { createClass } from "@/lib/classes";
import { readJson, str } from "@/lib/http";

export async function POST(request: Request) {
  const user = await apiUser();
  if (!user) return unauthorized();
  const name = str((await readJson(request)).name, 80);
  if (!name) return NextResponse.json({ error: "Give the class a name." }, { status: 400 });
  return NextResponse.json({ id: createClass(user.id, name) });
}
