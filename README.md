# Reader

Reader is a small Next.js app for turning pasted text into OpenAI-generated speech, then following along with word-level highlighting while the audio plays.

Copyright (c) 2026 Andrew Hyde. Released under the [MIT License](./LICENSE).

## What It Does

- Generates text-to-speech audio with OpenAI
- Aligns spoken audio back to the original text for live highlighting
- Lets you preview built-in voices before generating a full reading
- Saves readings locally in the current browser with IndexedDB

This repository is an open-source app, not an npm package. `package.json` intentionally remains `"private": true`.

## Stack

- Next.js 16 App Router
- React 19
- Tailwind CSS v4
- OpenAI Node SDK
- pnpm

## Requirements

- Node.js `>=20.9.0`
- pnpm `>=10`
- An OpenAI API key with access to text-to-speech and transcription models

CI runs against Node `20.19.4` and pnpm `10.28.2`.

## Environment Variables

Copy the example file and create a local env file:

```bash
cp .env.example .env.local
```

Supported variables:

- `OPENAI_API_KEY` (required): used by the server routes that call OpenAI
- `READER_PASSWORD` (optional): enables a shared-password gate backed by an `HttpOnly` cookie

## Local Development

Install dependencies:

```bash
pnpm install
```

Start the app:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

## Scripts

- `pnpm dev`: run the local development server
- `pnpm lint`: run ESLint
- `pnpm test`: run the Vitest suite
- `pnpm build`: build the production app

## Privacy and Cost Notes

- Pasted text is sent to OpenAI when you generate a full reading. Voice previews use a hardcoded sample and do not send your text.
- Generated readings are stored in the current browser's IndexedDB. They do not sync across devices.
- Running the app spends the API credits for the `OPENAI_API_KEY` configured on the server.
- Cost estimates shown in the UI are only estimates. They are based on assumptions in [lib/costs.ts](./lib/costs.ts) and may drift from current vendor pricing.

## Product Limitations

- The optional password gate is suitable for light personal protection, not public multi-user hosting.
- Word alignment currently assumes English transcription via `whisper-1`.
- Long text is split into chunks for TTS processing; very long inputs will make multiple API calls.
- Saved readings are browser-local only.
- Read mode depends on OpenAI successfully generating both speech and transcription timestamps.

## Maintainer Notes

Current server routes:

- `POST /api/auth`: validate the optional shared password and set the session cookie
- `DELETE /api/auth`: clear the session cookie
- `POST /api/read`: generate preview audio or a full streamed reading

If you plan to host a public demo, add rate limiting, stronger authentication, request-size controls, and clearer abuse monitoring before exposing the API to the internet.

Before making the repository public, review git history for any previously committed secrets or private content, even if the current working tree is clean.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for development expectations, pull request guidance, and the pre-publication checklist.
