// Sefaria helpers + the Claude tool definitions that wrap them.
// The Sefaria API is public and needs no key.

import { createTtlCache } from "./cache.js";

export const SEFARIA = "https://www.sefaria.org";
export const SEFARIA_TIMEOUT_MS = 10_000;

// Shared cache for text / commentary / search results (1h TTL, ~500 entries).
export const sefariaCache = createTtlCache({ ttlMs: 60 * 60 * 1000, maxEntries: 500 });

export function stripHtml(s) {
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

export function flattenText(t) {
  if (t == null) return [];
  if (typeof t === "string") return [stripHtml(t)].filter(Boolean);
  if (Array.isArray(t)) return t.flatMap(flattenText);
  return [];
}

// Sefaria's canonical URL form: the space before the section numbers becomes ".",
// ":" becomes ".", and spaces inside the title become "_" — e.g. "Genesis 32:25" →
// Genesis.32.25, "Pirkei Avot 1:14" → Pirkei_Avot.1.14 (matching the links the
// system prompt asks the model to write).
export function refToUrl(ref) {
  const path = String(ref)
    .trim()
    .replace(/\s+/g, " ")
    .replace(/ (?=\d[^ ]*$)/, ".")
    .replace(/:/g, ".")
    .replace(/ /g, "_");
  return `${SEFARIA}/${path}`;
}

// Combine the per-request timeout with an optional caller signal (client disconnect).
function fetchSignal(signal) {
  const timeout = AbortSignal.timeout(SEFARIA_TIMEOUT_MS);
  if (!signal) return timeout;
  return typeof AbortSignal.any === "function" ? AbortSignal.any([timeout, signal]) : timeout;
}

export async function sefariaFetch(url, options = {}) {
  const { signal, ...rest } = options;
  let res;
  try {
    res = await fetch(url, {
      ...rest,
      signal: fetchSignal(signal),
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...rest.headers,
      },
    });
  } catch (err) {
    if (err?.name === "TimeoutError") {
      throw new Error(`Sefaria timed out after ${SEFARIA_TIMEOUT_MS / 1000}s for ${url}`, {
        cause: err,
      });
    }
    throw err;
  }
  if (!res.ok) {
    throw new Error(`Sefaria returned ${res.status} for ${url}`);
  }
  return res.json();
}

// Return the cached value for `key`, or compute it and cache it unless it is an error result.
async function cached(key, compute) {
  const hit = sefariaCache.get(key);
  if (hit !== undefined) return hit;
  const value = await compute();
  if (value && !value.error) sefariaCache.set(key, value);
  return value;
}

export async function searchSefaria({ query, size = 8 } = {}, { signal } = {}) {
  const q = String(query ?? "").trim();
  if (!q) return { error: "query is required" };
  const n = Math.min(Math.max(Number(size) || 8, 1), 15);
  return cached(`search:${n}:${q.toLowerCase()}`, async () => {
    const body = {
      aggs: [],
      field: "naive_lemmatizer",
      filter_fields: [],
      filters: [],
      query: q,
      size: n,
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
      signal,
    });
    const hits = data?.hits?.hits ?? [];
    if (!hits.length) {
      return { results: [], note: "No results. Try fewer, stronger keywords." };
    }
    return {
      results: hits.map((h) => {
        const src = h._source ?? {};
        const highlight = h.highlight?.naive_lemmatizer?.[0] ?? h.highlight?.exact?.[0] ?? "";
        return {
          ref: src.ref ?? h._id,
          category: Array.isArray(src.path) ? src.path.join(" > ") : src.path,
          snippet: stripHtml(highlight).slice(0, 300),
        };
      }),
    };
  });
}

export async function getText({ ref } = {}, { signal } = {}) {
  const r = String(ref ?? "").trim();
  if (!r) return { error: "ref is required" };
  return cached(`text:${r}`, async () => {
    // Sefaria v3 texts API: primary (usually Hebrew) + translation (usually English)
    const data = await sefariaFetch(
      `${SEFARIA}/api/v3/texts/${encodeURIComponent(r)}?version=primary&version=translation&return_format=text_only`,
      { signal }
    );
    const out = {
      ref: data.ref ?? r,
      title: data.indexTitle ?? undefined,
      url: refToUrl(data.ref ?? r),
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
        error: `No text found for "${r}". Check the ref format (e.g. "Shabbat 31a", "Genesis 32:25", "Pirkei Avot 1:14") or search first.`,
      };
    }
    return out;
  });
}

export async function getCommentaries({ ref } = {}, { signal } = {}) {
  const r = String(ref ?? "").trim();
  if (!r) return { error: "ref is required" };
  return cached(`related:${r}`, async () => {
    const data = await sefariaFetch(`${SEFARIA}/api/related/${encodeURIComponent(r)}`, { signal });
    const links = (data?.links ?? []).filter((l) =>
      ["Commentary", "Quotation", "Midrash", "Talmud", "Halakhah"].includes(l.category)
    );
    if (!links.length) {
      return { ref: r, note: "No commentaries or related texts found on Sefaria for this ref." };
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
      ref: r,
      related: byCategory,
      tip: "Use get_text on any of these refs to read them.",
    };
  });
}

// --- Claude tool definitions ---------------------------------------------------
// Tool inputs are tiny, so eager_input_streaming is intentionally left off
// (the API's default buffering also validates inputs for us).

export const TOOLS = [
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

export async function executeTool(name, input, { signal } = {}) {
  switch (name) {
    case "search_sefaria":
      return searchSefaria(input, { signal });
    case "get_text":
      return getText(input, { signal });
    case "get_commentaries":
      return getCommentaries(input, { signal });
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
