import OpenAI from "openai";
import { NextResponse } from "next/server";
import { alignWordsToText, SpokenWord } from "@/lib/reader";
import { DEFAULT_VOICE, isTtsVoice, PREVIEW_SAMPLE_TEXT, TtsVoice } from "@/lib/tts";

const FIRST_CHUNK_LIMIT = 2200;
const CHUNK_LIMIT = 3800;
const REMAINING_CHUNK_CONCURRENCY = 2;
const VOICE_INSTRUCTIONS =
  "Speak in a silky smooth, calm, grounded voice with gentle warmth, clear diction, and a steady pace that is easy to follow.";

type ReadRequest = {
  mode?: "preview" | "read";
  text?: string;
  voice?: string;
};

function getOpenAIClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  return new OpenAI({ apiKey });
}

function takeChunk(remaining: string, limit: number) {
  if (remaining.length <= limit) {
    return { chunk: remaining, rest: "" };
  }

  let splitAt = -1;
  const searchWindow = remaining.slice(0, limit);

  const lastParagraph = searchWindow.lastIndexOf("\n\n");
  if (lastParagraph > limit * 0.3) {
    splitAt = lastParagraph + 2;
  }

  if (splitAt < 0) {
    const lastPeriod = searchWindow.lastIndexOf(". ");
    if (lastPeriod > limit * 0.3) {
      splitAt = lastPeriod + 2;
    }
  }

  if (splitAt < 0) {
    const lastSpace = searchWindow.lastIndexOf(" ");
    splitAt = lastSpace > 0 ? lastSpace + 1 : limit;
  }

  return {
    chunk: remaining.slice(0, splitAt),
    rest: remaining.slice(splitAt),
  };
}

function splitTextIntoChunks(text: string): string[] {
  if (text.length <= FIRST_CHUNK_LIMIT) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let limit = FIRST_CHUNK_LIMIT;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    const next = takeChunk(remaining, limit);
    chunks.push(next.chunk);
    remaining = next.rest;
    limit = CHUNK_LIMIT;
  }

  return chunks;
}

async function generateChunk(
  openai: OpenAI,
  text: string,
  voice: TtsVoice,
) {
  const speechResponse = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice,
    input: text,
    instructions: VOICE_INSTRUCTIONS,
    response_format: "mp3",
  });

  const audio = Buffer.from(await speechResponse.arrayBuffer());

  const audioFile = new File([audio], "reader.mp3", { type: "audio/mpeg" });
  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: "whisper-1",
    language: "en",
    prompt: text,
    response_format: "verbose_json",
    timestamp_granularities: ["word"],
  });

  const words: SpokenWord[] =
    transcription.words?.map((w) => ({
      word: w.word,
      start: w.start,
      end: w.end,
    })) ?? [];

  const tokens = alignWordsToText(text, words);

  return { audio, tokens };
}

export async function POST(request: Request) {
  const openai = getOpenAIClient();

  if (!openai) {
    return NextResponse.json(
      { error: "Missing OPENAI_API_KEY. Add it to your environment before using the app." },
      { status: 500 },
    );
  }

  let body: ReadRequest;
  try {
    body = (await request.json()) as ReadRequest;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  const { mode, text, voice } = body;
  const selectedVoice: TtsVoice = isTtsVoice(voice) ? voice : DEFAULT_VOICE;
  const isPreview = mode === "preview";
  const cleanedText = isPreview ? PREVIEW_SAMPLE_TEXT : text?.trim();

  if (!cleanedText) {
    return NextResponse.json({ error: "Paste some text first." }, { status: 400 });
  }

  // Preview mode: single short TTS call, no alignment
  if (isPreview) {
    try {
      const speechResponse = await openai.audio.speech.create({
        model: "gpt-4o-mini-tts",
        voice: selectedVoice,
        input: cleanedText,
        instructions: VOICE_INSTRUCTIONS,
        response_format: "mp3",
      });
      const audioBuffer = Buffer.from(await speechResponse.arrayBuffer());
      return NextResponse.json({
        audioBase64: audioBuffer.toString("base64"),
        mimeType: "audio/mpeg",
        voice: selectedVoice,
        model: "gpt-4o-mini-tts",
      });
    } catch (error) {
      console.error("Preview failed", error);
      return NextResponse.json(
        { error: "Could not generate preview." },
        { status: 500 },
      );
    }
  }

  // Read mode: stream chunks as NDJSON
  const chunks = splitTextIntoChunks(cleanedText);
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const firstChunk = await generateChunk(openai, chunks[0], selectedVoice);
        controller.enqueue(
          encoder.encode(
            JSON.stringify({
              chunkIndex: 0,
              totalChunks: chunks.length,
              audioBase64: firstChunk.audio.toString("base64"),
              mimeType: "audio/mpeg",
              tokens: firstChunk.tokens,
            }) + "\n",
          ),
        );

        const inFlight = new Map<number, Promise<Awaited<ReturnType<typeof generateChunk>>>>();
        const startChunk = (index: number) => {
          if (index >= chunks.length || inFlight.has(index)) {
            return;
          }

          inFlight.set(index, generateChunk(openai, chunks[index], selectedVoice));
        };

        for (
          let index = 1;
          index < Math.min(chunks.length, 1 + REMAINING_CHUNK_CONCURRENCY);
          index += 1
        ) {
          startChunk(index);
        }

        for (let i = 1; i < chunks.length; i++) {
          const generated = await inFlight.get(i);

          if (!generated) {
            throw new Error(`Missing generation task for chunk ${i}`);
          }

          inFlight.delete(i);
          startChunk(i + REMAINING_CHUNK_CONCURRENCY);

          const line = JSON.stringify({
            chunkIndex: i,
            totalChunks: chunks.length,
            audioBase64: generated.audio.toString("base64"),
            mimeType: "audio/mpeg",
            tokens: generated.tokens,
          });

          controller.enqueue(encoder.encode(line + "\n"));
        }
      } catch (error) {
        console.error("Failed to generate speech", error);
        const errLine = JSON.stringify({ error: "OpenAI could not generate audio." });
        controller.enqueue(encoder.encode(errLine + "\n"));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Transfer-Encoding": "chunked",
      "Cache-Control": "no-cache",
    },
  });
}
