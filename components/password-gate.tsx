"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function PasswordGate() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const response = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };

      if (!response.ok) {
        throw new Error(payload.error ?? "Incorrect password.");
      }

      setPassword("");
      router.refresh();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : "Could not sign in.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-5 py-8">
      <div className="w-full max-w-md rounded-[2rem] border border-border bg-[#fbf7f1] p-8 shadow-[0_24px_80px_rgba(57,44,27,0.08)]">
        <p className="text-xs font-medium uppercase tracking-[0.24em] text-muted">
          Protected
        </p>
        <h1 className="mt-3 font-serif text-4xl tracking-tight text-foreground">
          Reader
        </h1>
        <p className="mt-3 text-sm leading-6 text-muted">
          Enter the app password to generate or play saved readings.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
          <label className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">Password</span>
            <input
              autoComplete="current-password"
              className="h-12 rounded-xl border border-border bg-white px-4 text-sm text-foreground outline-none transition focus:border-accent focus:ring-2 focus:ring-accent/20"
              disabled={isSubmitting}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              value={password}
            />
          </label>

          <button
            className="h-12 rounded-xl bg-foreground px-5 text-sm font-medium text-white transition hover:bg-foreground/85 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={isSubmitting || password.length === 0}
            type="submit"
          >
            {isSubmitting ? "Unlocking..." : "Unlock"}
          </button>

          {error && (
            <p className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">
              {error}
            </p>
          )}
        </form>
      </div>
    </main>
  );
}
