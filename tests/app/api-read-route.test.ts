import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthCookieValue } from "@/lib/auth";

const cookiesMock = vi.fn();
const speechCreateMock = vi.fn();
const transcriptionCreateMock = vi.fn();
const OpenAIMock = vi.fn(function OpenAI() {
  return {
    audio: {
      speech: { create: speechCreateMock },
      transcriptions: { create: transcriptionCreateMock },
    },
  };
});

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

vi.mock("openai", () => ({
  default: OpenAIMock,
}));

const ORIGINAL_ENV = process.env;

describe("POST /api/read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.READER_PASSWORD;
    delete process.env.OPENAI_API_KEY;
    cookiesMock.mockResolvedValue({
      get: vi.fn(() => undefined),
    });
  });

  it("rejects unauthenticated requests when password protection is enabled", async () => {
    process.env.READER_PASSWORD = "letmein";
    const { POST } = await import("@/app/api/read/route");

    const response = await POST(
      new Request("http://localhost/api/read", {
        method: "POST",
        body: JSON.stringify({ mode: "preview" }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Enter the app password before generating audio.",
    });
  });

  it("rejects invalid JSON bodies", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const { POST } = await import("@/app/api/read/route");

    const response = await POST(
      new Request("http://localhost/api/read", {
        method: "POST",
        body: "{",
        headers: { "Content-Type": "application/json" },
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid request." });
  });

  it("returns an error when the OpenAI API key is missing", async () => {
    const { POST } = await import("@/app/api/read/route");

    const response = await POST(
      new Request("http://localhost/api/read", {
        method: "POST",
        body: JSON.stringify({ text: "Hello world" }),
      }),
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "Missing OPENAI_API_KEY. Add it to your environment before using the app.",
    });
  });

  it("returns preview audio for authenticated requests", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    process.env.READER_PASSWORD = "letmein";
    cookiesMock.mockResolvedValue({
      get: vi.fn(() => ({ value: createAuthCookieValue() })),
    });
    speechCreateMock.mockResolvedValue({
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    });

    const { POST } = await import("@/app/api/read/route");
    const response = await POST(
      new Request("http://localhost/api/read", {
        method: "POST",
        body: JSON.stringify({ mode: "preview", voice: "marin" }),
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      audioBase64: "AQID",
      mimeType: "audio/mpeg",
      voice: "marin",
      model: "gpt-4o-mini-tts",
    });
    expect(transcriptionCreateMock).not.toHaveBeenCalled();
  });

  it("streams read-mode chunks with alignment data", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    speechCreateMock.mockResolvedValue({
      arrayBuffer: async () => Uint8Array.from([9, 8, 7]).buffer,
    });
    transcriptionCreateMock.mockResolvedValue({
      words: [
        { word: "Hello", start: 0, end: 0.4 },
        { word: "world", start: 0.5, end: 0.9 },
      ],
    });

    const { POST } = await import("@/app/api/read/route");
    const response = await POST(
      new Request("http://localhost/api/read", {
        method: "POST",
        body: JSON.stringify({ mode: "read", text: "Hello world." }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/x-ndjson");

    const body = await response.text();
    const [line] = body.trim().split("\n");
    const payload = JSON.parse(line) as {
      audioBase64: string;
      chunkIndex: number;
      totalChunks: number;
      timedWords: Array<{ normalized: string }>;
    };

    expect(payload.audioBase64).toBe("CQgH");
    expect(payload.chunkIndex).toBe(0);
    expect(payload.totalChunks).toBe(1);
    expect(payload.timedWords.map((word) => word.normalized)).toEqual(["hello", "world"]);
  });
});
