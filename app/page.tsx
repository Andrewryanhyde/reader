import { cookies } from "next/headers";
import { PasswordGate } from "@/components/password-gate";
import { ReaderApp } from "@/components/reader-app";
import {
  AUTH_COOKIE_NAME,
  isAuthenticatedCookieValue,
  isPasswordProtectionEnabled,
} from "@/lib/auth";

export const dynamic = "force-dynamic";

type HomeProps = {
  searchParams?: Promise<{ entry?: string | string[] }> | { entry?: string | string[] };
};

export default async function Home({ searchParams }: HomeProps) {
  const resolvedSearchParams = await Promise.resolve(searchParams);
  const initialEntryId = Array.isArray(resolvedSearchParams?.entry)
    ? resolvedSearchParams?.entry[0] ?? null
    : resolvedSearchParams?.entry ?? null;

  if (!isPasswordProtectionEnabled()) {
    return <ReaderApp passwordProtected={false} initialEntryId={initialEntryId} />;
  }

  const cookieStore = await cookies();
  const isAuthenticated = isAuthenticatedCookieValue(
    cookieStore.get(AUTH_COOKIE_NAME)?.value,
  );

  if (!isAuthenticated) {
    return <PasswordGate />;
  }

  return <ReaderApp passwordProtected initialEntryId={initialEntryId} />;
}
