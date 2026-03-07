import { cookies } from "next/headers";
import { PasswordGate } from "@/components/password-gate";
import { ReaderApp } from "@/components/reader-app";
import {
  AUTH_COOKIE_NAME,
  isAuthenticatedCookieValue,
  isPasswordProtectionEnabled,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function Home() {
  if (!isPasswordProtectionEnabled()) {
    return <ReaderApp passwordProtected={false} />;
  }

  const cookieStore = await cookies();
  const isAuthenticated = isAuthenticatedCookieValue(
    cookieStore.get(AUTH_COOKIE_NAME)?.value,
  );

  if (!isAuthenticated) {
    return <PasswordGate />;
  }

  return <ReaderApp passwordProtected />;
}
