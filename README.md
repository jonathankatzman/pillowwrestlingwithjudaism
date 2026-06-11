# 🛏️ Pillow Wrestling with Judaism

*Jacob wrestled an angel all night. You can start with a cushion.*

A conversational web app for wrestling with Jewish tradition — gently. Ask real, modern questions (doubt, ethics, AI, grief, money, God) and get answers **voiced by sages across 2,000 years** — Hillel, Shammai, Rabbi Akiva, Rashi, Rambam, Ramban, the Baal Shem Tov, Buber, Heschel, and Rabbi Jonathan Sacks — every answer **grounded in real texts fetched live from the [Sefaria](https://www.sefaria.org) library**, with clickable citations so you can read the sources yourself.

## How it works

- **Frontend** — a single-page chat UI (`public/`). Pick your study partner, ask a question, watch the answer stream in. "Texts consulted" chips link straight to Sefaria.
- **Server** (`server.js`) — Express + the Anthropic SDK. Each question runs an agentic loop where Claude (`claude-opus-4-8`, adaptive thinking) has three live tools:
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

## Project layout

```
server.js          Express server, Sefaria tools, streaming agent loop (SSE)
sages.js           Sage personas + system prompt construction
public/index.html  Chat UI
public/style.css   Parchment-and-pillow design
public/app.js      Streaming client, sage picker, markdown rendering
```

## Notes

- Conversation history lives in the browser; the server is stateless per request.
- The system prompt is cached (`cache_control: ephemeral`) so multi-turn chats stay fast and cheap.
- Voices are AI interpretations of historical thinkers, offered with affection and chutzpah. For practical halakhic decisions — *aseh lecha rav*, get yourself a teacher ([Pirkei Avot 1:6](https://www.sefaria.org/Pirkei_Avot.1.6)).
