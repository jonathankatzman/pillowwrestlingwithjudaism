import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import { SAGES, buildSystemPrompt } from "./sages.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- tiny .env loader (no dependency) ---------------------------------------
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

const MODEL = "claude-sonnet-4-6";
const SEFARIA = "https://www.sefaria.org";
const MAX_AGENT_TURNS = 8;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from env

// --- Sefaria helpers ---------------------------------------------------------

function stripHtml(s) {
  return String(s ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function flattenText(t) {
  if (t == null) return [];
  if (typeof t === "string") return [stripHtml(t)].filter(Boolean);
  if (Array.isArray(t)) return t.flatMap(flattenText);
  return [];
}

function refToUrl(ref) {
  return `${SEFARIA}/${String(ref).trim().replace(/ /g, "_").replace(/:/g, ".")}`;
}

async function sefariaFetch(url, options) {
  const res = await fetch(url, {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`Sefaria returned ${res.status} for ${url}`);
  }
  return res.json();
}

async function searchSefaria({ query, size = 8 }) {
  const body = {
    aggs: [],
    field: "naive_lemmatizer",
    filter_fields: [],
    filters: [],
    query,
    size: Math.min(Number(size) || 8, 15),
    slop: 10,
    sort_fields: ["pagesheetrank"],
    sort_method: "score",
    sort_reverse: false,
    sort_score_missing: 0.04,
    source_proj: true,
    type: "text",
  };
  const data = await sefariaFetch(`${SEFARIA}/api/search-wrapper`, {
    method: "POST",
    body: JSON.stringify(body),
  });
  const hits = data?.hits?.hits ?? [];
  if (!hits.length) {
    return { results: [], note: "No results. Try fewer, stronger keywords." };
  }
  return {
    results: hits.map((h) => {
      const src = h._source ?? {};
      const highlight =
        h.highlight?.naive_lemmatizer?.[0] ?? h.highlight?.exact?.[0] ?? "";
      return {
        ref: src.ref ?? h._id,
        category: Array.isArray(src.path) ? src.path.join(" > ") : src.path,
        snippet: stripHtml(highlight).slice(0, 300),
      };
    }),
  };
}

async function getText({ ref }) {
  const tref = encodeURIComponent(String(ref).trim());
  // Sefaria v3 texts API: primary (usually Hebrew) + translation (usually English)
  const data = await sefariaFetch(
    `${SEFARIA}/api/v3/texts/${tref}?version=primary&version=translation&return_format=text_only`
  );
  const out = {
    ref: data.ref ?? ref,
    title: data.indexTitle ?? undefined,
    url: refToUrl(data.ref ?? ref),
    hebrew: null,
    english: null,
  };
  for (const v of data.versions ?? []) {
    const text = flattenText(v.text).join(" ");
    if (!text) continue;
    const lang = v.actualLanguage ?? v.language;
    if (lang === "he" && !out.hebrew) out.hebrew = text.slice(0, 2500);
    else if (lang === "en" && !out.english) out.english = text.slice(0, 2500);
  }
  if (!out.hebrew && !out.english) {
    return {
      error: `No text found for "${ref}". Check the ref format (e.g. "Shabbat 31a", "Genesis 32:25", "Pirkei Avot 1:14") or search first.`,
    };
  }
  return out;
}

async function getCommentaries({ ref }) {
  const tref = encodeURIComponent(String(ref).trim());
  const data = await sefariaFetch(`${SEFARIA}/api/related/${tref}`);
  const links = (data?.links ?? []).filter((l) =>
    ["Commentary", "Quotation", "Midrash", "Talmud", "Halakhah"].includes(l.category)
  );
  if (!links.length) {
    return { ref, note: "No commentaries or related texts found on Sefaria for this ref." };
  }
  const byCategory = {};
  for (const l of links) {
    (byCategory[l.category] ??= []).push(l.sourceRef ?? l.ref);
  }
  // Cap each category so the result stays small
  for (const k of Object.keys(byCategory)) {
    byCategory[k] = [...new Set(byCategory[k])].slice(0, 12);
  }
  return {
    ref,
    related: byCategory,
    tip: "Use get_text on any of these refs to read them.",
  };
}

// --- Claude tool definitions ---------------------------------------------------

const TOOLS = [
  {
    name: "search_sefaria",
    description:
      "Full-text search across the Sefaria library of Jewish texts (Tanakh, Talmud, Midrash, halakhah, philosophy, Hasidut, and more). Call this FIRST when you need sources for a topic and don't already know the exact reference. Use strong content keywords in English (e.g. 'love your neighbor', 'repentance forgiveness', 'honor parents'), not full sentences. Returns refs with snippets.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Keyword query, e.g. 'whoever saves a single life'",
        },
        size: {
          type: "integer",
          description: "Number of results (default 8, max 15)",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_text",
    description:
      "Fetch the actual text (Hebrew original + English translation) of a specific reference from Sefaria. Call this for ANY passage you plan to quote, so quotations are exact. Ref format examples: 'Shabbat 31a', 'Genesis 32:25', 'Pirkei Avot 1:14', 'Mishneh Torah, Repentance 2:1', 'Rashi on Genesis 1:1', 'Berakhot 5a:10-12'.",
    input_schema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "A Sefaria text reference, e.g. 'Eruvin 13b' or 'Deuteronomy 30:19'",
        },
      },
      required: ["ref"],
    },
  },
  {
    name: "get_commentaries",
    description:
      "List commentaries and related texts (midrash, Talmud citations, halakhic codes) on a specific verse or passage, from Sefaria's link database. Call this when asked what commentators said about a verse, or to find how a verse echoes through later tradition. Follow up with get_text to read a specific commentary.",
    input_schema: {
      type: "object",
      properties: {
        ref: {
          type: "string",
          description: "The base text ref, e.g. 'Genesis 22:2' or 'Exodus 20:12'",
        },
      },
      required: ["ref"],
    },
  },
];

async function executeTool(name, input) {
  switch (name) {
    case "search_sefaria":
      return searchSefaria(input);
    case "get_text":
      return getText(input);
    case "get_commentaries":
      return getCommentaries(input);
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// --- API ---------------------------------------------------------------------

app.get("/api/sages", (_req, res) => {
  res.json(
    SAGES.map(({ id, name, hebrew, years, era, emoji, blurb, color }) => ({
      id, name, hebrew, years, era, emoji, blurb, color,
    }))
  );
});

app.post("/api/ask", async (req, res) => {
  const { sage = "beit-midrash", messages: history } = req.body ?? {};
  if (!Array.isArray(history) || history.length === 0) {
    return res.status(400).json({ error: "messages array required" });
  }
  // SSE response
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (event, data) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  // Only role/content strings come from the client; tool turns are built here.
  let messages = history
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));

  const system = buildSystemPrompt(sage);
  const sources = new Map(); // ref -> url

  try {
    for (let turn = 0; turn < MAX_AGENT_TURNS; turn++) {
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 8096,
        system,
        tools: TOOLS,
        messages,
      });

      stream.on("text", (delta) => send("text", { delta }));

      const message = await stream.finalMessage();

      if (message.stop_reason === "pause_turn") {
        messages.push({ role: "assistant", content: message.content });
        continue;
      }

      if (message.stop_reason !== "tool_use") break; // end_turn etc. — done

      messages.push({ role: "assistant", content: message.content });

      const toolResults = [];
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        send("tool", { name: block.name, input: block.input });
        let result;
        try {
          result = await executeTool(block.name, block.input);
        } catch (err) {
          result = { error: String(err?.message ?? err) };
        }
        // Track texts actually consulted, for the sources panel
        if (block.name === "get_text" && result?.ref && !result.error) {
          sources.set(result.ref, result.url ?? refToUrl(result.ref));
        }
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
          ...(result?.error ? { is_error: true } : {}),
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    if (sources.size > 0) {
      send("sources", {
        sources: [...sources.entries()].map(([ref, url]) => ({ ref, url })),
      });
    }
    send("done", {});
  } catch (err) {
    console.error("ask error:", err);
    let friendly = "Something went wrong in the study house. Please try again.";
    if (err instanceof Anthropic.AuthenticationError) {
      friendly = "Invalid or missing Anthropic API key — set ANTHROPIC_API_KEY in .env and restart.";
    } else if (/resolve authentication method/i.test(String(err?.message))) {
      friendly = "No Anthropic API key configured — copy .env.example to .env, add your key, and restart the server.";
    } else if (err instanceof Anthropic.RateLimitError) {
      friendly = "We're being rate limited. Take a breath and try again in a moment.";
    } else if (err instanceof Anthropic.APIError) {
      friendly = `API error (${err.status}): ${err.message}`;
    }
    send("error", { message: friendly });
  } finally {
    res.end();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🛏️  Pillow Wrestling with Judaism → http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.warn("⚠️  No ANTHROPIC_API_KEY in env — questions will only work if an `ant auth login` profile is configured. Otherwise add a key to .env.");
  }
});
