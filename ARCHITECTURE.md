# Architecture

How Pillow Wrestling with Judaism is put together, and why. Read this before changing the
agent loop, the SSE contract, or deployment. For setup and deploy steps see `README.md`; for
working rules aimed at coding agents see `CLAUDE.md`.

## Shape of the system

```
Browser (public/)                    Server (server.js + lib/)                 External
─────────────────                    ─────────────────────────                 ────────
app.js keeps the chat history  ──►   POST /api/ask
  in memory + localStorage           1. validateAskBody  (lib/validate.js)
  sends {sage, messages}             2. rate limit       (lib/rateLimit.js)
                                     3. open SSE stream
                               ◄──   4. runAgent         (lib/agent.js)  ──►  Anthropic Messages API
  renders text/tool/sources              loop: model ⇄ tools                   (claude-sonnet-5-5)
  events as they arrive                  tools          (lib/sefaria.js) ──►  Sefaria public API
                                                                               (no key needed)
GET /api/sages  ◄──  sages.js (personas, @-mention labels)
GET /api/health ◄──  {ok:true}
```

- **No database, no sessions.** The server is stateless per request. The browser owns the
  conversation and resends it (capped) on every question. That is what makes Vercel's
  serverless model a good fit, and it is the first thing to revisit if accounts or shareable
  conversations are ever added (Supabase was the candidate).
- **Plain JS, no build step.** Node ESM on the server, a single vanilla-JS script in the
  browser. Keep it that way unless there is a strong reason.

## Server

### `server.js`: HTTP layer

- `createApp({getClient, rateLimiter, agent})` builds the Express 5 app. Every dependency
  is injectable, which is how `test/server.test.js` runs without network or an API key.
- `export default app` is what Vercel's zero-config Express support imports. `app.listen`
  only runs when the file is executed directly **and** `VERCEL` is unset, so importing the app
  (tests, Vercel) never opens a port.
- `/api/ask` order matters: **validate → rate limit → open SSE → run agent**. Invalid requests
  return 400 JSON and don't consume quota; rate-limited ones return 429 JSON with `Retry-After`.
  After the SSE headers are flushed, all problems are reported as SSE `error` events.
- Client disconnects: `res.on("close")` with `!res.writableFinished` aborts an
  `AbortController` whose signal goes to the Anthropic stream and every Sefaria fetch, so a
  closed tab stops spending tokens.
- A final error middleware turns body-parser failures (bad JSON, >1 MB) into JSON 400/413.
- `.env` is loaded by a tiny inline parser (local dev only; Vercel injects env vars).

### SSE contract (`/api/ask` → `public/app.js`)

| event     | data                      | meaning                                         |
| --------- | ------------------------- | ----------------------------------------------- |
| `text`    | `{delta}`                 | streamed answer text (never thinking)           |
| `tool`    | `{name, input}`           | a Sefaria tool call started (UI shows a status) |
| `sources` | `{sources: [{ref, url}]}` | texts actually fetched with `get_text`          |
| `error`   | `{message}`               | user-facing message; no `done` follows          |
| `done`    | `{}`                      | success                                         |

Change both sides together if you touch this.

### `lib/agent.js`: the agent loop

A hand-written tool loop (not the SDK tool runner) so it can stream, abort, and control the
last turn. Key behaviors:

- **Model and request shape.** Uses `client.beta.messages.stream` with:
  - `model: "claude-sonnet-5-5"`
  - `max_tokens: 16000`
  - `output_config: {effort: "medium"}`
  - the server-side refusal fallback: `betas: ["server-side-fallback-2026-07-01"]` with
    `fallbacks: "default"`
  - **no `thinking` field**: this model always thinks adaptively, and `{type:"disabled"}`
    returns a 400.
- **Echo full content.** On tool turns the whole `message.content` (thinking blocks included)
  is pushed back unchanged. `contentForEcho` only strips blocks that precede a mid-stream
  `fallback` block, as the fallback docs require.
- **Parallel tools.** All `tool_use` blocks in one turn run with `Promise.all`; all
  `tool_result`s go back in one user message, in `tool_use` order. Sources are also recorded in
  that order so the UI list is deterministic.
- **Turn limit.** `MAX_AGENT_TURNS = 8` normal turns; if the model still wants tools, one more
  call with `tool_choice: {type: "none"}` forces an answer. (`any`/`tool` forced choices are a
  400 on this model; `none` is fine.)
- **Never end silently.** Refusal → `error` with `REFUSAL_MESSAGE`; no text at all →
  `error` with `NO_ANSWER_MESSAGE`.
- Text deltas come only from the SDK's `text` event, so between-tool "thinking out loud"
  (returned as thinking blocks on this model) never reaches the user.

### `lib/sefaria.js`: tools

Three tools are exposed to Claude (definitions in `TOOLS`):

| tool               | Sefaria endpoint                                                                      | returns                                            |
| ------------------ | ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `search_sefaria`   | `POST /api/search-wrapper`                                                            | refs, category path, snippet (≤15 hits)            |
| `get_text`         | `GET /api/v3/texts/{ref}?version=primary&version=translation&return_format=text_only` | Hebrew + English (≤2500 chars each), canonical URL |
| `get_commentaries` | `GET /api/related/{ref}`                                                              | related refs grouped by category (≤12 each)        |

- Every fetch has a 10 s timeout combined with the caller's abort signal (`AbortSignal.any`,
  hence Node ≥ 20).
- Successful results are cached in-process (`lib/cache.js`, 1 h TTL, 500 entries). On
  Vercel this cache is per instance and short-lived, which is fine.
- `refToUrl` produces Sefaria's canonical URL form (`Genesis.32.25`, `Pirkei_Avot.1.14`),
  matching what the system prompt tells the model to write.
- ⚠️ `search-wrapper` is an undocumented Sefaria endpoint used by their own site. If search
  breaks, check it first.

### `lib/validate.js`: request limits

`validateAskBody` is a pure function. The browser resends the whole conversation, so long chats
are **trimmed, not rejected**: keep the last 30 messages, truncate old assistant answers over
4000 chars, drop oldest turns until ≤ 40k chars total, and make sure history starts with a
user turn. Only malformed input, an unknown sage, or a _user_ message over 4000 chars is a 400.

### `lib/rateLimit.js`: abuse guard

In-memory per-IP limiter (first hop of `x-forwarded-for`): default 10 questions / 10 min and
50 / day, configurable via `RATE_LIMIT_*` env vars (0 disables). On Vercel it is per instance,
so it is **best effort**. The real guards are a Vercel Firewall rate-limit rule on `/api/ask`
and a spend limit in the Anthropic Console.

### `sages.js`: personas

Each sage has display fields (`name`, `hebrew`, `years`, `era`, `emoji`, `blurb`, `color`),
a `voice` prompt, and `mention: {label, aliases}` for @-mentions. `buildSystemPrompt(id)`
combines shared `CORE_RULES` (grounding/citation rules) with the persona's voice into a
single system block marked `cache_control: ephemeral`. `GET /api/sages` exposes everything
except `voice`.

**Adding a sage** = one new entry in `SAGES` (unique `id`, a `mention`). The frontend picks it
up automatically; nothing in `public/` needs changing.

## Frontend (`public/`)

- `index.html` + `style.css`: parchment design, responsive down to iPhone widths (560px
  breakpoint), reduced-motion support.
- `app.js`: a single script, no framework:
  - Loads sages, renders the picker, and drives @-mention parsing/autocomplete from `sage.mention`.
    One mention → that sage answers; several → the Beit Midrash convenes; none → picker choice.
  - Streams SSE over `fetch` (not `EventSource`, because it's a POST) and renders a minimal,
    **escape-first** markdown subset (links are http(s) only).
  - Persists `{sage, messages}` (with each answer's sage and sources) in
    `localStorage["pwwj:v1"]`. Every storage access is in try/catch; the app works without it.
  - Stop button (AbortController), Retry on any failure, New conversation control.
  - Sends at most the last 30 messages, each ≤ 4000 chars, mirroring the server caps.

## Testing and CI

- `npm test` runs `node --test` (100 tests, `test/`). No network: Sefaria is stubbed
  via `fetch`, Claude via a scripted fake client (`test/helpers.js`), and the HTTP tests use
  `createApp` with injected fakes on `listen(0)`. One test checks the real SDK's outgoing
  request (beta header present, no `thinking`/`betas` in the body).
- `npm run lint` (ESLint flat config) and `npm run format:check` (Prettier, width 100, double
  quotes). `public/*.html` and `public/*.css` are excluded from Prettier on purpose.
- CI: `.github/workflows/ci.yml`, Node 20 and 22: `npm ci` → lint → format check → test.
- Not covered by automated tests: the frontend (it was verified with ad-hoc Playwright runs
  against a mock server) and live calls to Sefaria and Anthropic.

## Deployment

- **Target: Vercel** (Hobby is fine for a personal, non-commercial project). Zero-config
  Express: `server.js` default export becomes the function, `public/` is served from the CDN.
  No `vercel.json`; Fluid compute's default 300 s function duration covers a streamed answer.
  Required env var: `ANTHROPIC_API_KEY`.
- It previously ran on Railway (still works unchanged via `npm start`; ~$5/mo Hobby plan).
- Cost is dominated by the Anthropic API, not hosting. Keep the Console spend limit and the
  Vercel Firewall rule in place before sharing the link.

## History

- **v1:** single-file Express server with a sequential tool loop on `claude-sonnet-4-6`,
  deployed on Railway.
- **Oct 2026 overhaul** (branch `claude/vibrant-darwin-69pdbn`):
  - split into `lib/` modules
  - rate limiting and history caps
  - abort on disconnect
  - forced final turn at the turn limit
  - Sefaria timeouts, cache and parallel tool calls
  - moved to `claude-sonnet-5-5` with refusal fallback
  - frontend persistence, Stop/Retry and New conversation
  - tests, lint and CI
  - SDK 0.131, Express 5
  - Vercel prep

## Known gaps / next ideas

- No live end-to-end test. After any model or Sefaria change, ask a few real questions.
- Rate limiting is per instance on Vercel; a shared store (Upstash/Vercel KV/Supabase) would
  make it exact.
- Saved/shareable conversations or accounts would need a database (Supabase is the natural fit).
- `effort: "medium"` is a starting point; tune it against real questions for quality vs.
  latency and cost.
