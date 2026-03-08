# Reader

Turn any text into a personal audiobook with word-by-word highlighting that keeps your eyes locked to what you're hearing.

I built this because I struggle to get through long articles. Having the words highlighted as they're spoken keeps me focused in a way that reading alone doesn't. If you have ADHD or just find your attention wandering mid-paragraph, this might help.

<!-- Add a screenshot or GIF here: ![Reader screenshot](screenshot.png) -->

## How It Works

1. You paste text and pick a voice
2. The server sends the text to OpenAI's `gpt-4o-mini-tts` to generate speech
3. The generated audio is transcribed back through `whisper-1` to get word-level timestamps
4. An alignment algorithm (LCS-based) maps the timestamps back to your original text
5. During playback, each word highlights in sync with the audio

Readings are saved in your browser's IndexedDB so you can close the tab and pick up where you left off. Nothing is stored on a server.

## Getting Started

You'll need Node.js `>=20.9.0`, pnpm `>=10`, and an [OpenAI API key](https://platform.openai.com/api-keys) with access to TTS and transcription models.

```bash
git clone https://github.com/Andrewryanhyde/reader.git
cd reader
pnpm install
cp .env.example .env.local
```

Add your API key to `.env.local`, then:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

Optionally set `READER_PASSWORD` in `.env.local` to put a shared password gate in front of the app.

## Stack

Next.js 16 (App Router), React 19, Tailwind CSS v4, OpenAI Node SDK.

## Scripts

- `pnpm dev` — local dev server
- `pnpm lint` — ESLint
- `pnpm test` — Vitest suite
- `pnpm build` — production build

CI runs against Node `20.19.4` and pnpm `10.28.2`.

## Privacy and Cost

- Your text is sent to OpenAI when you generate a reading.
- Each reading costs roughly **$0.02 per minute** of audio (TTS generation + Whisper alignment). The library sidebar shows a cost estimate per reading.
- Readings are stored in your browser only. They don't sync anywhere.
- Cost estimates are based on assumptions in [lib/costs.ts](./lib/costs.ts) and may drift from current OpenAI pricing.

## Limitations

- English only. The Whisper alignment step is hardcoded to `language: "en"`.
- Long text is split into chunks, so very long inputs make multiple API calls.
- The optional password gate is for personal use, not hardened multi-user auth.
- Saved readings are browser-local. Clear your browser data and they're gone.

## Contributing

PRs are welcome. Run `pnpm lint && pnpm test && pnpm build` before submitting.

## License

[MIT](./LICENSE)
