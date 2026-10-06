import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  SEFARIA,
  TOOLS,
  stripHtml,
  flattenText,
  refToUrl,
  sefariaFetch,
  searchSefaria,
  getText,
  getCommentaries,
  executeTool,
  sefariaCache,
} from "../lib/sefaria.js";
import { jsonResponse } from "./helpers.js";

// Realistic (trimmed) Sefaria response shapes.
const SEARCH_RESPONSE = {
  took: 12,
  timed_out: false,
  hits: {
    total: { value: 2, relation: "eq" },
    max_score: 13.2,
    hits: [
      {
        _index: "text-1",
        _type: "_doc",
        _id: "Shabbat 31a:6 (William Davidson Edition - English)",
        _score: 13.2,
        _source: {
          ref: "Shabbat 31a:6",
          heRef: "שבת ל״א א:ו",
          version: "William Davidson Edition - English",
          lang: "en",
          path: ["Talmud", "Bavli", "Seder Moed", "Shabbat"],
          pagesheetrank: 0.9,
        },
        highlight: {
          naive_lemmatizer: [
            "That which is <b>hateful</b> to you&nbsp;do not do to <b>another</b>; that is the entire Torah",
          ],
        },
      },
      {
        _id: "Leviticus 19:18 (The Contemporary Torah)",
        _source: { ref: "Leviticus 19:18", path: "Tanakh/Torah/Leviticus" },
        highlight: { exact: ["Love your <em>neighbor</em> as yourself"] },
      },
    ],
  },
};

const TEXT_RESPONSE = {
  versions: [
    {
      versionTitle: "William Davidson Edition - Vocalized Aramaic",
      language: "he",
      actualLanguage: "he",
      text: ["<b>דַּעֲלָךְ</b> סְנֵי", "לְחַבְרָךְ לָא תַּעֲבֵיד"],
    },
    {
      versionTitle: "William Davidson Edition - English",
      language: "en",
      actualLanguage: "en",
      text: [["That which is hateful to you,", ""], ["do not do to another."]],
    },
  ],
  available_versions: [],
  ref: "Shabbat 31a:6",
  heRef: "שבת ל״א א:ו",
  sections: [62, 6],
  toSections: [62, 6],
  indexTitle: "Shabbat",
  categories: ["Talmud", "Bavli", "Seder Moed"],
};

const RELATED_RESPONSE = {
  links: [
    {
      _id: "1",
      category: "Commentary",
      sourceRef: "Rashi on Genesis 22:2:1",
      anchorRef: "Genesis 22:2",
    },
    {
      _id: "2",
      category: "Commentary",
      sourceRef: "Rashi on Genesis 22:2:1",
      anchorRef: "Genesis 22:2",
    },
    {
      _id: "3",
      category: "Commentary",
      sourceRef: "Ramban on Genesis 22:2:1",
      anchorRef: "Genesis 22:2",
    },
    { _id: "4", category: "Talmud", ref: "Sanhedrin 89b:6", anchorRef: "Genesis 22:2" },
    { _id: "5", category: "Tanakh", sourceRef: "Genesis 12:1", anchorRef: "Genesis 22:2" },
  ],
  sheets: [],
  notes: [],
  webpages: [],
  topics: [],
  manuscripts: [],
  media: [],
};

describe("stripHtml", () => {
  it("removes tags, decodes common entities and collapses whitespace", () => {
    assert.equal(
      stripHtml("  <b>Love</b>&nbsp;your &amp; <i>neighbor</i>\n &lt;3 &quot;x&quot; &#39;y&#39; "),
      `Love your & neighbor <3 "x" 'y'`
    );
  });
  it("handles null/undefined/non-strings", () => {
    assert.equal(stripHtml(null), "");
    assert.equal(stripHtml(undefined), "");
    assert.equal(stripHtml(42), "42");
  });
});

describe("flattenText", () => {
  it("flattens nested arrays, strips html and drops empties", () => {
    assert.deepEqual(flattenText(["<b>a</b>", ["b", ["", "c"]], null]), ["a", "b", "c"]);
  });
  it("returns [] for null and non-text values", () => {
    assert.deepEqual(flattenText(null), []);
    assert.deepEqual(flattenText({ text: "x" }), []);
    assert.deepEqual(flattenText(""), []);
  });
  it("wraps a plain string", () => {
    assert.deepEqual(flattenText("hi <br/>there"), ["hi there"]);
  });
});

describe("refToUrl", () => {
  it("builds Sefaria's canonical URL form", () => {
    assert.equal(refToUrl("Genesis 32:25"), `${SEFARIA}/Genesis.32.25`);
    assert.equal(refToUrl(" Pirkei Avot 1:14 "), `${SEFARIA}/Pirkei_Avot.1.14`);
    assert.equal(refToUrl("Shabbat 31a"), `${SEFARIA}/Shabbat.31a`);
    assert.equal(refToUrl("Berakhot 5a:10-12"), `${SEFARIA}/Berakhot.5a.10-12`);
    assert.equal(refToUrl("Rashi on Genesis 1:1:1"), `${SEFARIA}/Rashi_on_Genesis.1.1.1`);
    assert.equal(
      refToUrl("Mishneh Torah, Repentance 2:1"),
      `${SEFARIA}/Mishneh_Torah,_Repentance.2.1`
    );
  });
  it("leaves refs without section numbers as underscored titles", () => {
    assert.equal(refToUrl("Pirkei Avot"), `${SEFARIA}/Pirkei_Avot`);
  });
});

describe("Sefaria API helpers (stubbed fetch)", () => {
  beforeEach(() => sefariaCache.clear());

  it("searchSefaria posts the query and parses hits", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => jsonResponse(SEARCH_RESPONSE));
    const out = await searchSefaria({ query: "  hateful to your fellow ", size: 99 });

    assert.equal(fetchMock.mock.callCount(), 1);
    const [url, init] = fetchMock.mock.calls[0].arguments;
    assert.equal(url, `${SEFARIA}/api/search-wrapper`);
    assert.equal(init.method, "POST");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.headers.accept, "application/json");
    const body = JSON.parse(init.body);
    assert.equal(body.query, "hateful to your fellow");
    assert.equal(body.size, 15, "size is capped at 15");
    assert.equal(body.type, "text");

    assert.deepEqual(out, {
      results: [
        {
          ref: "Shabbat 31a:6",
          category: "Talmud > Bavli > Seder Moed > Shabbat",
          snippet: "That which is hateful to you do not do to another; that is the entire Torah",
        },
        {
          ref: "Leviticus 19:18",
          category: "Tanakh/Torah/Leviticus",
          snippet: "Love your neighbor as yourself",
        },
      ],
    });
  });

  it("searchSefaria falls back to _id when _source.ref is missing and truncates snippets", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse({ hits: { hits: [{ _id: "X 1:1", highlight: { exact: ["y".repeat(500)] } }] } })
    );
    const out = await searchSefaria({ query: "x" });
    assert.equal(out.results[0].ref, "X 1:1");
    assert.equal(out.results[0].snippet.length, 300);
    assert.equal(out.results[0].category, undefined);
  });

  it("searchSefaria returns a note when there are no hits", async (t) => {
    t.mock.method(globalThis, "fetch", async () => jsonResponse({ hits: { hits: [] } }));
    const out = await searchSefaria({ query: "zzzz" });
    assert.deepEqual(out.results, []);
    assert.match(out.note, /No results/);
  });

  it("searchSefaria requires a query without calling fetch", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => jsonResponse({}));
    assert.deepEqual(await searchSefaria({ query: "   " }), { error: "query is required" });
    assert.deepEqual(await searchSefaria(), { error: "query is required" });
    assert.equal(fetchMock.mock.callCount(), 0);
  });

  it("getText requests primary + translation and parses both languages", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => jsonResponse(TEXT_RESPONSE));
    const out = await getText({ ref: "Shabbat 31a:6" });

    const [url] = fetchMock.mock.calls[0].arguments;
    assert.equal(
      url,
      `${SEFARIA}/api/v3/texts/Shabbat%2031a%3A6?version=primary&version=translation&return_format=text_only`
    );
    assert.deepEqual(out, {
      ref: "Shabbat 31a:6",
      title: "Shabbat",
      url: `${SEFARIA}/Shabbat.31a.6`,
      hebrew: "דַּעֲלָךְ סְנֵי לְחַבְרָךְ לָא תַּעֲבֵיד",
      english: "That which is hateful to you, do not do to another.",
    });
  });

  it("getText caps each language at 2500 chars and keeps the first version per language", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        ref: "Long 1",
        versions: [
          { language: "en", text: "a".repeat(3000) },
          { language: "en", text: "second" },
          { language: "en", actualLanguage: "he", text: "עברית" },
        ],
      })
    );
    const out = await getText({ ref: "Long 1" });
    assert.equal(out.english.length, 2500);
    assert.equal(out.hebrew, "עברית", "actualLanguage wins over language");
    assert.equal(out.title, undefined);
  });

  it("getText returns an error (and does not cache it) when no text is found", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () =>
      jsonResponse({ ref: "Nowhere 1", versions: [{ language: "en", text: [] }] })
    );
    const out = await getText({ ref: "Nowhere 1" });
    assert.match(out.error, /No text found for "Nowhere 1"/);
    await getText({ ref: "Nowhere 1" });
    assert.equal(fetchMock.mock.callCount(), 2, "error results are not cached");
  });

  it("getText requires a ref", async () => {
    assert.deepEqual(await getText({}), { error: "ref is required" });
  });

  it("getCommentaries groups, dedupes and filters related links", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () =>
      jsonResponse(RELATED_RESPONSE)
    );
    const out = await getCommentaries({ ref: "Genesis 22:2" });
    assert.equal(fetchMock.mock.calls[0].arguments[0], `${SEFARIA}/api/related/Genesis%2022%3A2`);
    assert.deepEqual(out, {
      ref: "Genesis 22:2",
      related: {
        Commentary: ["Rashi on Genesis 22:2:1", "Ramban on Genesis 22:2:1"],
        Talmud: ["Sanhedrin 89b:6"],
      },
      tip: "Use get_text on any of these refs to read them.",
    });
  });

  it("getCommentaries caps each category at 12", async (t) => {
    const links = Array.from({ length: 20 }, (_, i) => ({
      category: "Midrash",
      sourceRef: `Bereshit Rabbah 56:${i}`,
    }));
    t.mock.method(globalThis, "fetch", async () => jsonResponse({ links }));
    const out = await getCommentaries({ ref: "Genesis 22:2" });
    assert.equal(out.related.Midrash.length, 12);
  });

  it("getCommentaries returns a note when nothing relevant is linked", async (t) => {
    t.mock.method(globalThis, "fetch", async () =>
      jsonResponse({ links: [{ category: "Tanakh" }] })
    );
    const out = await getCommentaries({ ref: "Genesis 1:1" });
    assert.equal(out.ref, "Genesis 1:1");
    assert.match(out.note, /No commentaries/);
  });

  it("caches successful results (case-insensitive search key)", async (t) => {
    const fetchMock = t.mock.method(globalThis, "fetch", async () => jsonResponse(SEARCH_RESPONSE));
    const a = await searchSefaria({ query: "Love Neighbor" });
    const b = await searchSefaria({ query: "love neighbor" });
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.deepEqual(a, b);
    await searchSefaria({ query: "love neighbor", size: 3 });
    assert.equal(fetchMock.mock.callCount(), 2, "different size is a different key");

    fetchMock.mock.mockImplementation(async () => jsonResponse(TEXT_RESPONSE));
    await getText({ ref: "Shabbat 31a:6" });
    await getText({ ref: " Shabbat 31a:6 " });
    assert.equal(fetchMock.mock.callCount(), 3);
  });

  it("throws on non-2xx responses", async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response("nope", { status: 503 }));
    await assert.rejects(getText({ ref: "Genesis 1:1" }), /Sefaria returned 503/);
  });

  it("turns a timeout into a readable error", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    await assert.rejects(sefariaFetch(`${SEFARIA}/api/x`), (err) => {
      assert.match(err.message, /Sefaria timed out after 10s/);
      assert.equal(err.cause.name, "TimeoutError");
      return true;
    });
  });

  it("propagates the caller's abort signal to fetch", async (t) => {
    t.mock.method(globalThis, "fetch", (_url, init) => {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
      });
    });
    const ac = new AbortController();
    const p = getText({ ref: "Genesis 1:1" }, { signal: ac.signal });
    ac.abort();
    await assert.rejects(p, { name: "AbortError" });
  });

  it("passes other network errors through", async (t) => {
    t.mock.method(globalThis, "fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await assert.rejects(searchSefaria({ query: "x" }), /fetch failed/);
  });
});

describe("executeTool", () => {
  beforeEach(() => sefariaCache.clear());

  it("dispatches each tool by name and passes the signal through", async (t) => {
    const signals = [];
    t.mock.method(globalThis, "fetch", async (url, init) => {
      signals.push(init.signal);
      if (url.includes("search-wrapper")) return jsonResponse(SEARCH_RESPONSE);
      if (url.includes("/api/v3/texts/")) return jsonResponse(TEXT_RESPONSE);
      return jsonResponse(RELATED_RESPONSE);
    });
    const ac = new AbortController();
    const s = await executeTool("search_sefaria", { query: "q" }, { signal: ac.signal });
    const g = await executeTool("get_text", { ref: "Shabbat 31a:6" });
    const c = await executeTool("get_commentaries", { ref: "Genesis 22:2" });
    assert.equal(s.results.length, 2);
    assert.equal(g.ref, "Shabbat 31a:6");
    assert.ok(c.related.Commentary);
    assert.equal(signals.length, 3);
    ac.abort();
    assert.equal(signals[0].aborted, true, "combined signal follows the caller's signal");
    assert.equal(signals[1].aborted, false);
  });

  it("returns an error for unknown tools", async () => {
    assert.deepEqual(await executeTool("nope", {}), { error: "Unknown tool: nope" });
  });

  it("every TOOLS entry is dispatchable", async (t) => {
    t.mock.method(globalThis, "fetch", async () => jsonResponse({}));
    for (const tool of TOOLS) {
      const out = await executeTool(tool.name, {});
      assert.doesNotMatch(String(out.error), /Unknown tool/);
      assert.ok(tool.input_schema.required.length > 0);
    }
  });
});
