import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import { createApp, friendlyError } from "../server.js";
import { runAgent } from "../lib/agent.js";
import { createRateLimiter } from "../lib/rateLimit.js";
import { SAGES } from "../sages.js";
import { fakeClient, toolTurn, toolUse, textTurn } from "./helpers.js";

const noLimit = () => createRateLimiter({ windowMax: 0, dailyMax: 0 });

async function listen(app) {
  const server = app.listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  };
}

function ask(base, body, headers = {}) {
  return fetch(`${base}/api/ask`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function parseSse(text) {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((chunk) => {
      const event = chunk.match(/^event: (.*)$/m)?.[1];
      const data = JSON.parse(chunk.match(/^data: (.*)$/m)?.[1] ?? "null");
      return [event, data];
    });
}

const QUESTION = { messages: [{ role: "user", content: "Why wrestle?" }] };

describe("HTTP API", () => {
  let srv;
  let agentCalls;
  let agentImpl;

  before(async () => {
    const app = createApp({
      getClient: () => ({ fake: true }),
      rateLimiter: noLimit(),
      agent: (opts) => {
        agentCalls.push(opts);
        return agentImpl(opts);
      },
    });
    srv = await listen(app);
  });
  after(() => srv.close());
  beforeEach(() => {
    agentCalls = [];
    agentImpl = async ({ emit }) => {
      emit("text", { delta: "hi" });
      emit("done", {});
    };
  });

  it("GET /api/health", async () => {
    const res = await fetch(`${srv.base}/api/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });

  it("GET /api/sages returns public fields including mention, not the prompt voice", async () => {
    const res = await fetch(`${srv.base}/api/sages`);
    const sages = await res.json();
    assert.equal(sages.length, SAGES.length);
    for (const s of sages) {
      assert.equal(typeof s.id, "string");
      assert.equal(typeof s.mention?.label, "string");
      assert.ok(Array.isArray(s.mention.aliases));
      assert.equal(s.voice, undefined);
    }
    assert.equal(sages[0].id, "beit-midrash");
  });

  it("serves the static UI", async () => {
    const res = await fetch(`${srv.base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/html/);
    await res.text();
  });

  describe("POST /api/ask validation", () => {
    const bad = [
      ["no messages", {}, /messages array required/],
      ["unknown sage", { sage: "nobody", ...QUESTION }, /unknown sage/],
      [
        "last message from assistant",
        {
          messages: [
            { role: "user", content: "q" },
            { role: "assistant", content: "a" },
          ],
        },
        /last message must be from the user/,
      ],
      [
        "oversize user message",
        { messages: [{ role: "user", content: "x".repeat(4001) }] },
        /too long/,
      ],
      ["malformed JSON", "{not json", /invalid JSON body/],
    ];
    for (const [name, body, re] of bad) {
      it(`400 for ${name}`, async () => {
        const res = await ask(srv.base, body);
        assert.equal(res.status, 400);
        assert.match(res.headers.get("content-type"), /application\/json/);
        assert.match((await res.json()).error, re);
        assert.equal(agentCalls.length, 0);
      });
    }

    it("413 JSON error for an oversize body", async () => {
      const res = await ask(srv.base, {
        messages: [{ role: "user", content: "x".repeat(1_100_000) }],
      });
      assert.equal(res.status, 413);
      assert.match((await res.json()).error, /too large/);
    });
  });

  it("streams SSE and passes validated input to the agent", async () => {
    const res = await ask(srv.base, { sage: "hillel", ...QUESTION });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type"), /text\/event-stream/);
    assert.equal(res.headers.get("cache-control"), "no-cache, no-transform");
    assert.deepEqual(parseSse(await res.text()), [
      ["text", { delta: "hi" }],
      ["done", {}],
    ]);
    const [opts] = agentCalls;
    assert.deepEqual(opts.client, { fake: true });
    assert.deepEqual(opts.messages, QUESTION.messages);
    assert.match(opts.system[0].text, /HILLEL/);
    assert.ok(opts.signal instanceof AbortSignal);
  });

  it("reports agent failures as a friendly SSE error event", async (t) => {
    const consoleError = t.mock.method(console, "error", () => {});
    agentImpl = async ({ emit }) => {
      emit("text", { delta: "partial" });
      throw new Anthropic.APIConnectionError({ message: "down" });
    };
    const events = parseSse(await (await ask(srv.base, QUESTION)).text());
    assert.deepEqual(events, [
      ["text", { delta: "partial" }],
      ["error", { message: "Couldn't reach Claude just now. Please try again in a moment." }],
    ]);
    assert.equal(consoleError.mock.callCount(), 1);
  });

  it("aborts the agent's signal when the client disconnects", async () => {
    let resolveAborted;
    const aborted = new Promise((r) => (resolveAborted = r));
    agentImpl = ({ emit, signal }) =>
      new Promise((_resolve, reject) => {
        emit("text", { delta: "thinking..." });
        signal.addEventListener("abort", () => {
          resolveAborted(true);
          reject(new Anthropic.APIUserAbortError());
        });
      });

    const ac = new AbortController();
    const res = await fetch(`${srv.base}/api/ask`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(QUESTION),
      signal: ac.signal,
    });
    const reader = res.body.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: text/);
    ac.abort();
    const timeout = new Promise((_r, reject) =>
      setTimeout(() => reject(new Error("agent signal was not aborted")), 2000).unref()
    );
    assert.equal(await Promise.race([aborted, timeout]), true);
    assert.equal(agentCalls[0].signal.aborted, true);
  });
});

describe("HTTP API with the real agent loop and a fake model", () => {
  it("streams tool, text, sources and done events in order", async () => {
    const client = fakeClient([
      toolTurn(
        toolUse("t0", "search_sefaria", { query: "neighbor" }),
        toolUse("t1", "get_text", { ref: "Leviticus 19:18" })
      ),
      textTurn("Love your neighbor."),
    ]);
    const executeTool = async (name, input) =>
      name === "get_text"
        ? { ref: input.ref, url: "https://www.sefaria.org/Leviticus.19.18", english: "..." }
        : { results: [{ ref: "Leviticus 19:18" }] };
    const app = createApp({
      getClient: () => client,
      rateLimiter: noLimit(),
      agent: (opts) => runAgent({ ...opts, executeTool }),
    });
    const srv = await listen(app);
    try {
      const events = parseSse(await (await ask(srv.base, QUESTION)).text());
      assert.deepEqual(events, [
        ["tool", { name: "search_sefaria", input: { query: "neighbor" } }],
        ["tool", { name: "get_text", input: { ref: "Leviticus 19:18" } }],
        ["text", { delta: "Love your neighbor." }],
        [
          "sources",
          { sources: [{ ref: "Leviticus 19:18", url: "https://www.sefaria.org/Leviticus.19.18" }] },
        ],
        ["done", {}],
      ]);
      assert.equal(client.calls.length, 2);
    } finally {
      await srv.close();
    }
  });

  it("refusal ends the stream with an error event", async () => {
    const client = fakeClient([{ stop_reason: "refusal", content: [] }]);
    const srv = await listen(createApp({ getClient: () => client, rateLimiter: noLimit() }));
    try {
      const events = parseSse(await (await ask(srv.base, QUESTION)).text());
      assert.equal(events.length, 1);
      assert.equal(events[0][0], "error");
    } finally {
      await srv.close();
    }
  });
});

describe("rate limiting", () => {
  it("returns 429 with Retry-After once the window is exhausted, per client IP", async () => {
    let now = 0;
    const rateLimiter = createRateLimiter({
      windowMs: 60_000,
      windowMax: 1,
      dailyMax: 0,
      now: () => now,
    });
    let agentRuns = 0;
    const app = createApp({
      getClient: () => ({}),
      rateLimiter,
      agent: async ({ emit }) => {
        agentRuns++;
        emit("done", {});
      },
    });
    const srv = await listen(app);
    try {
      const ip = { "x-forwarded-for": "203.0.113.9" };
      assert.equal((await ask(srv.base, QUESTION, ip)).status, 200);
      now = 15_000;
      const limited = await ask(srv.base, QUESTION, ip);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "45");
      const body = await limited.json();
      assert.equal(body.retryAfterSec, 45);
      assert.match(body.error, /Slow down/);
      assert.equal(agentRuns, 1);

      // Invalid requests are rejected before (and without consuming) the limit.
      assert.equal((await ask(srv.base, {}, ip)).status, 400);

      // A different client is unaffected.
      assert.equal(
        (await ask(srv.base, QUESTION, { "x-forwarded-for": "198.51.100.1" })).status,
        200
      );
    } finally {
      await srv.close();
    }
  });

  it("uses the daily message when the daily cap is hit", async () => {
    const rateLimiter = createRateLimiter({ windowMax: 0, dailyMax: 1, now: () => 0 });
    const srv = await listen(
      createApp({ getClient: () => ({}), rateLimiter, agent: async ({ emit }) => emit("done", {}) })
    );
    try {
      await (await ask(srv.base, QUESTION)).text();
      const res = await ask(srv.base, QUESTION);
      assert.equal(res.status, 429);
      assert.equal(res.headers.get("retry-after"), String(24 * 60 * 60));
      assert.match((await res.json()).error, /tomorrow/);
    } finally {
      await srv.close();
    }
  });
});

describe("friendlyError", () => {
  const headers = new Headers();
  it("maps SDK errors to user-facing messages", () => {
    assert.match(
      friendlyError(new Anthropic.AuthenticationError(401, {}, "bad key", headers)),
      /API key/
    );
    assert.match(
      friendlyError(new Anthropic.RateLimitError(429, {}, "slow", headers)),
      /rate limited/
    );
    assert.match(
      friendlyError(new Anthropic.APIConnectionError({ message: "x" })),
      /Couldn't reach Claude/
    );
    assert.match(
      friendlyError(new Anthropic.InternalServerError(500, {}, "oops", headers)),
      /^API error \(500\)/
    );
    assert.match(
      friendlyError(new Error("Could not resolve authentication method. Expected apiKey...")),
      /No Anthropic API key configured/
    );
    assert.match(friendlyError(new Error("boom")), /Something went wrong/);
    assert.match(friendlyError(undefined), /Something went wrong/);
  });
});
