import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const AUTH_COOKIE_NAME = "reader_session";
export const READER_PASSWORD_ENV_NAME = "READER_PASSWORD";

const AUTH_COOKIE_TTL_SECONDS = 60 * 60 * 24 * 30;
const AUTH_COOKIE_SCOPE = "reader";

function getConfiguredPassword() {
  const password = process.env[READER_PASSWORD_ENV_NAME];
  return typeof password === "string" && password.length > 0 ? password : null;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: string, right: string) {
  return timingSafeEqual(sha256(left), sha256(right));
}

function signPayload(payload: string, password: string) {
  return createHmac("sha256", password).update(payload).digest("base64url");
}

export function isPasswordProtectionEnabled() {
  return getConfiguredPassword() !== null;
}

export function isValidPassword(password: string) {
  const configuredPassword = getConfiguredPassword();

  if (!configuredPassword) {
    return true;
  }

  return safeEqual(password, configuredPassword);
}

export function createAuthCookieValue() {
  const configuredPassword = getConfiguredPassword();

  if (!configuredPassword) {
    return null;
  }

  const expiresAt = Date.now() + AUTH_COOKIE_TTL_SECONDS * 1000;
  const payload = `${AUTH_COOKIE_SCOPE}:${expiresAt}`;
  const signature = signPayload(payload, configuredPassword);

  return `${payload}.${signature}`;
}

export function isAuthenticatedCookieValue(cookieValue: string | null | undefined) {
  const configuredPassword = getConfiguredPassword();

  if (!configuredPassword) {
    return true;
  }

  if (!cookieValue) {
    return false;
  }

  const separatorIndex = cookieValue.lastIndexOf(".");

  if (separatorIndex <= 0) {
    return false;
  }

  const payload = cookieValue.slice(0, separatorIndex);
  const providedSignature = cookieValue.slice(separatorIndex + 1);
  const expectedSignature = signPayload(payload, configuredPassword);

  if (!safeEqual(providedSignature, expectedSignature)) {
    return false;
  }

  const [scope, expiresAtValue, ...rest] = payload.split(":");

  if (scope !== AUTH_COOKIE_SCOPE || rest.length > 0) {
    return false;
  }

  const expiresAt = Number(expiresAtValue);

  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

export const AUTH_COOKIE_OPTIONS = {
  httpOnly: true,
  maxAge: AUTH_COOKIE_TTL_SECONDS,
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};
