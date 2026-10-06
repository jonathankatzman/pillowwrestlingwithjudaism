# 🛏️ Pillow Wrestling with Judaism

*Jacob wrestled an angel all night. You can start with a cushion.*

A conversational web app for wrestling with Jewish tradition — gently. Ask real, modern questions (doubt, ethics, AI, grief, money, God) and get answers **voiced by sages across 2,000 years** — Hillel, Shammai, Rabbi Akiva, Rashi, Rambam, Ramban, the Baal Shem Tov, Buber, Heschel, and Rabbi Jonathan Sacks — every answer **grounded in real texts fetched live from the [Sefaria](https://www.sefaria.org) library**, with clickable citations so you can read the sources yourself.

## How it works

- **Frontend** — a single-page chat UI (`public/`). Pick your study partner, ask a question, watch the answer stream in. "Texts consulted" chips link straight to Sefaria.
- **Server** (`server.js` + `lib/`) — Express + the Anthropic SDK. Each question runs a streaming agentic loop where Claude (`claude-sonnet-5-5`, adaptive thinking at `medium` effort) has three live tools (several calls in one turn run in parallel; Sefaria results are cached in memory for an hour):
  - `search_sefaria` — full-text search across the Sefaria library
  - `get_text` — fetch the Hebrew + English of any reference (so quotations are exact)
  - `get_commentaries` — list commentaries/midrash/halakhah linked to a verse
- **Personas** (`sages.js`) — each sage gets a voice prompt with their era, hallmark teachings, and interpretive style, plus shared grounding rules (cite real texts, honor machloket, don't anachronize). "The Beit Midrash" mode stages a cross-era debate.

## Setup

Requires Node 18+.

```bash
npm install
cp .env.example .env     # then paste your Anthropic API key into .env
npm start                # → http://localhost:3000
```

Get an API key at [platform.claude.com](https://platform.claude.com). The Sefaria API requires no key.

## Deploy to Vercel

`server.js` exports the Express app as its default export, so Vercel's zero-config Express support picks it up (and serves `public/` from its CDN). Locally it calls `app.listen`; on Vercel it doesn't.

1. Import the repo at [vercel.com/new](https://vercel.com/new) — no build settings needed.
2. In **Settings → Environment Variables**, set `ANTHROPIC_API_KEY`.
3. Optionally tune the per-IP limits on `/api/ask`: `RATE_LIMIT_WINDOW_MINUTES` (default 10), `RATE_LIMIT_WINDOW_MAX` (default 10), `RATE_LIMIT_DAILY_MAX` (default 50); `0` disables a limit.
4. Deploy, then check `https://<your-app>.vercel.app/api/health` returns `{"ok":true}`.

Answers stream for up to a minute or two; keep Fluid compute on (the default for new projects), whose default function duration of 300s covers that.

**Protect your wallet.** This is a public endpoint that spends your Anthropic credits. The built-in rate limit is in-memory and per instance, so on Vercel it is best effort only. Before sharing the link:

- Set a monthly **spend limit** in the [Anthropic Console](https://platform.claude.com) (under your organization's limits settings).
- Add a **Vercel Firewall rate-limit rule** for `/api/ask` (e.g. 10 requests / 10 min per IP) — that is the real guard.

## Project layout

```
server.js          Express app (exported for Vercel), /api routes, SSE streaming
lib/agent.js       Agent loop: Claude + tools, refusal fallback, max-turn wrap-up
lib/sefaria.js     Sefaria API helpers, tool definitions, timeouts + cache
lib/validate.js    /api/ask body validation and history caps
lib/rateLimit.js   In-memory per-IP rate limiter
lib/cache.js       Small TTL cache
sages.js           Sage personas (incl. @-mention labels/aliases) + system prompt
public/index.html  Chat UI
public/style.css   Parchment-and-pillow design
public/app.js      Streaming client, sage picker, markdown rendering
```

## Notes

- Conversation history lives in the browser; the server is stateless per request. It keeps the most recent 30 messages (≈40k characters) and rejects user messages over 4,000 characters.
- `GET /api/health` → `{"ok":true}`; `GET /api/sages` lists the personas, including each one's `mention: {label, aliases}` used for @-mentions.
- The system prompt is cached (`cache_control: ephemeral`) so multi-turn chats stay fast and cheap.
- Voices are AI interpretations of historical thinkers, offered with affection and chutzpah. For practical halakhic decisions — *aseh lecha rav*, get yourself a teacher ([Pirkei Avot 1:6](https://www.sefaria.org/Pirkei_Avot.1.6)).
