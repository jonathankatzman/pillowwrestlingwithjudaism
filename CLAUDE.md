# CLAUDE.md

Guidance for coding agents working in this repo. Read `ARCHITECTURE.md` for how the system
works and why; `README.md` for setup and deployment.

## What this is

A chat app where historical Jewish sages answer modern questions, grounded in texts fetched
live from Sefaria. Express 5 + `@anthropic-ai/sdk` on Node ≥ 20 (ESM), vanilla JS frontend, no
build step, no database. Deployed to Vercel (zero-config Express).

## Commands

```bash
npm install
npm start            # http://localhost:3000 (needs ANTHROPIC_API_KEY in .env for real answers)
npm run dev          # auto-restart
npm test             # node:test, no network or API key needed
npm run lint
npm run format       # or format:check
```

Before pushing, run `npm run lint && npm run format:check && npm test`. CI runs exactly these
on Node 20 and 22.

## Map

- `server.js`: `createApp(deps)` (injectable for tests), routes, SSE, `export default app`
- `lib/agent.js`: the model ⇄ tools loop (model, effort, fallback, turn limit)
- `lib/sefaria.js`: tool definitions + Sefaria API calls (timeouts, cache)
- `lib/validate.js`, `lib/rateLimit.js`, `lib/cache.js`: request caps, per-IP limits, TTL cache
- `sages.js`: personas, `mention` labels/aliases, `buildSystemPrompt`
- `public/app.js`: the whole client (SSE parsing, markdown, @-mentions, localStorage)
- `test/`: one test file per module plus `server.test.js`; fakes in `test/helpers.js`

## Rules and gotchas

- **SSE contract** (`text`, `tool`, `sources`, `error`, `done`) is shared by `server.js`/
  `lib/agent.js` and `public/app.js`; change both sides together.
- **Model API:** before changing anything in `lib/agent.js`, check current Claude API docs (use the
  `claude-api` skill). On `claude-sonnet-5-5`, do **not** send `thinking` (disabled is a 400),
  don't use forced `tool_choice` `any`/`tool` (400; `none` is fine), and always echo the full
  assistant `content` back on tool turns. The fallback beta header must match the
  `fallbacks: "default"` form.
- **Never let a request end silently.** Every path ends in `done` or an `error` event.
- **Keep it stateless.** No server-side session state; anything in memory (cache, rate limits)
  is per instance on Vercel and must be treated as best effort.
- **Adding a sage:** add one entry to `SAGES` in `sages.js` with a unique `id` and a `mention`.
  No frontend change is needed. Add/adjust tests if behavior changes.
- **Frontend safety:** markdown rendering escapes first; only http(s) links. Wrap every
  `localStorage` access in try/catch.
- **Tests must not hit the network.** Stub `fetch` / inject a fake client like the existing tests.
- `public/*.html` and `public/*.css` are intentionally excluded from Prettier (hand-aligned).
- Sefaria's `search-wrapper` endpoint is undocumented; if search breaks, suspect it first.
- The sandbox used to build this couldn't reach Sefaria, so live behavior was never tested
  end to end. After changing the model or tools, verify with a real key and a few questions.
- Don't commit `.env` or put keys in code; Vercel holds `ANTHROPIC_API_KEY`.
