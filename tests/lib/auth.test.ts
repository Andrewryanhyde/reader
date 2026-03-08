import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAuthCookieValue,
  isAuthenticatedCookieValue,
  isPasswordProtectionEnabled,
  isValidPassword,
} from "@/lib/auth";

const ORIGINAL_ENV = process.env;

describe("lib/auth", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-08T10:00:00.000Z"));
    process.env = { ...ORIGINAL_ENV };
    delete process.env.READER_PASSWORD;
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = ORIGINAL_ENV;
  });

  it("disables password protection when no password is configured", () => {
    expect(isPasswordProtectionEnabled()).toBe(false);
    expect(isValidPassword("anything")).toBe(true);
    expect(isAuthenticatedCookieValue(undefined)).toBe(true);
  });

  it("accepts the configured password and validates the signed cookie", () => {
    process.env.READER_PASSWORD = "correct horse battery staple";

    expect(isPasswordProtectionEnabled()).toBe(true);
    expect(isValidPassword("correct horse battery staple")).toBe(true);
    expect(isValidPassword("wrong")).toBe(false);

    const cookieValue = createAuthCookieValue();

    expect(cookieValue).toBeTruthy();
    expect(isAuthenticatedCookieValue(cookieValue)).toBe(true);
  });

  it("rejects tampered and expired cookies", () => {
    process.env.READER_PASSWORD = "swordfish";

    const cookieValue = createAuthCookieValue();
    expect(cookieValue).toBeTruthy();

    const tamperedCookie = `${cookieValue}extra`;
    expect(isAuthenticatedCookieValue(tamperedCookie)).toBe(false);

    vi.advanceTimersByTime(1000 * 60 * 60 * 24 * 31);
    expect(isAuthenticatedCookieValue(cookieValue)).toBe(false);
  });
});
