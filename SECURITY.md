# Security Policy

## Reporting a Vulnerability

Please do not open a public issue for security vulnerabilities.

Instead, [report a vulnerability through GitHub](https://github.com/Andrewryanhyde/reader/security/advisories/new) with:

- a clear description of the issue
- steps to reproduce it
- the affected routes, files, or configuration
- any suggested mitigation, if known

I will acknowledge receipt, investigate, and coordinate a fix before public disclosure when appropriate.

## Security Notes for This Project

- `OPENAI_API_KEY` is server-side and should never be committed.
- `READER_PASSWORD` is optional and is intended for light access control, not hardened multi-user security.
- `POST /api/read` can spend paid API credits. Do not expose it publicly without rate limiting and abuse controls.
- Browser-saved readings may contain sensitive user text. Avoid using shared browsers with production data.

## Supported Versions

Security fixes are only guaranteed for the latest commit on the default branch unless noted otherwise.
