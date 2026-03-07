# Reader

Paste text into a simple Next.js app, generate OpenAI text-to-speech audio, and follow along with live word highlighting while it plays.

## Stack

- Next.js App Router
- Tailwind CSS v4
- OpenAI Node SDK
- `pnpm`

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Add your API key:

```bash
cp .env.example .env.local
```

3. Start the app:

```bash
pnpm dev
```

4. Open [http://localhost:3000](http://localhost:3000)

## Features

- Pick from the built-in OpenAI TTS voices and preview each one before generating a full reading
- Generate a spoken version of the pasted text with live word highlighting
- Save your library locally in the current browser with IndexedDB, including generated audio chunks
- See an estimated per-reading API cost, including both speech generation and the transcription pass used for word timing

## Notes

- The server uses `gpt-4o-mini-tts` with a calm voice prompt.
- Word highlighting is produced by transcribing the generated audio with `whisper-1` word timestamps, then aligning those timestamps back onto the original pasted text.
- The app currently enforces a 4,000-character input cap because the installed OpenAI SDK type for `v1/audio/speech` documents a 4,096-character max input, while the current `gpt-4o-mini-tts` model page separately says the model supports up to 2,000 input tokens.
- Cost estimates are based on the current OpenAI pricing page: `gpt-4o-mini-tts` text input at `$0.60 / 1M tokens`, speech output estimated at `$0.015 / minute`, and `whisper-1` transcription at `$0.006 / minute`.
- Saved articles now live in browser IndexedDB, so they persist across reloads on the same browser/device but do not sync across devices.
