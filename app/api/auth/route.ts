import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import {
  AUTH_COOKIE_NAME,
  AUTH_COOKIE_OPTIONS,
  createAuthCookieValue,
  isPasswordProtectionEnabled,
  isValidPassword,
} from "@/lib/auth";

type LoginRequest = {
  password?: string;
};

export async function POST(request: Request) {
  if (!isPasswordProtectionEnabled()) {
    return NextResponse.json({ ok: true });
  }

  let body: LoginRequest;

  try {
    body = (await request.json()) as LoginRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (typeof body.password !== "string" || body.password.length === 0) {
    return NextResponse.json({ error: "Enter the app password." }, { status: 400 });
  }

  if (!isValidPassword(body.password)) {
    return NextResponse.json({ error: "Incorrect password." }, { status: 401 });
  }

  const cookieStore = await cookies();
  const authCookieValue = createAuthCookieValue();

  if (!authCookieValue) {
    return NextResponse.json({ error: "Password protection is not configured." }, { status: 500 });
  }

  cookieStore.set(AUTH_COOKIE_NAME, authCookieValue, AUTH_COOKIE_OPTIONS);

  return NextResponse.json({ ok: true });
}

export async function DELETE() {
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_COOKIE_NAME);

  return NextResponse.json({ ok: true });
}
