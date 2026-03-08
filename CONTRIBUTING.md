# Contributing

Thanks for contributing to Reader.

## Development Setup

1. Install dependencies:

```bash
pnpm install
```

2. Create a local env file:

```bash
cp .env.example .env.local
```

3. Set `OPENAI_API_KEY`. Set `READER_PASSWORD` only if you want the local password gate enabled.

4. Start the app:

```bash
pnpm dev
```

## Before Opening a Pull Request

Run the local checks:

```bash
pnpm lint
pnpm test
pnpm build
```

Please keep pull requests focused and update docs when behavior changes.

Update the public docs when you change:

- environment variables
- server route behavior
- OpenAI model assumptions
- storage format or persistence behavior
- security-sensitive flows such as auth or request validation

## Pull Request Guidance

- Describe the user-visible change and the implementation approach.
- Note any changes to env vars, route behavior, or saved data shape.
- Include tests for bug fixes and non-trivial behavior changes.
- Do not include real user text, generated readings, secrets, or private screenshots in the repository.

## Pre-Publication Checklist

Before flipping the repo from private to public, review git history for:

- accidentally committed secrets
- private sample content
- credentials or tokens in earlier commits
- generated assets derived from copyrighted or private source material

## Maintainer Approval

Contributions are welcome, but deployment and release decisions remain with the maintainer.
