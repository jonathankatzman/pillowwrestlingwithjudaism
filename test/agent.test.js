import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Anthropic from "@anthropic-ai/sdk";
import {
  runAgent,
  contentForEcho,
  MODEL,
  EFFORT,
  FALLBACK_BETA,
  MAX_AGENT_TURNS,
  REFUSAL_MESSAGE,
  NO_ANSWER_MESSAGE,
} from "../lib/agent.js";
import { TOOLS } from "../lib/sefaria.js";
import { fakeClient, thinking, toolUse, toolTurn, textTurn, collector, delay } from "./helpers.js";

const SYSTEM = [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }];
const QUESTION = [{ role: "user", content: "Why wrestle?" }];

const fakeText = (ref) => ({ ref, url: `https://www.sefaria.org/${ref}`, english: "..." });

function run(client, opts = {}) {
  const c = collector();
  const promise = runAgent({
    client,
    system: SYSTEM,
    messages: QUESTION,
    emit: c.emit,
    executeTool: async (_name, input) => fakeText(input.ref),
    ...opts,
  });
  return { ...c, promise };
}

describe("runAgent", () => {
  it("sends the expected request params (fallbacks, betas, effort; no thinking field)", async () => {
    const client = fakeClient([textTurn("Shalom")]);
    const ac = new AbortController();
    const { promise } = run(client, { signal: ac.signal });
    assert.deepEqual(await promise, { status: "done" });

    assert.equal(client.calls.length, 1);
    const { params, opts } = client.calls[0];
    assert.equal(params.model, MODEL);
    assert.equal(params.fallbacks, "default");
    assert.deepEqual(params.betas, [FALLBACK_BETA]);
    assert.deepEqual(params.output_config, { effort: EFFORT });
    assert.ok(!("thinking" in params), "thinking must be omitted (adaptive by default)");
    assert.ok(!("tool_choice" in params));
    assert.deepEqual(params.system, SYSTEM);
    assert.deepEqual(
      params.tools.map((t) => t.name),
      TOOLS.map((t) => t.name)
    );
    assert.deepEqual(params.messages, QUESTION);
    assert.equal(opts.signal, ac.signal);
  });

  it("does not mutate the caller's history", async () => {
    const history = [{ role: "user", content: "q", extra: true }];
    const snapshot = structuredClone(history);
    const client = fakeClient([
      toolTurn(toolUse("t0", "get_text", { ref: "A 1" })),
      textTurn("ok"),
    ]);
    await run(client, { messages: history }).promise;
    assert.deepEqual(history, snapshot);
    assert.deepEqual(client.calls[0].params.messages, [{ role: "user", content: "q" }]);
  });

  it("runs tools in parallel and returns results in tool_use order in one user message", async () => {
    const order = [];
    const executeTool = async (name, input) => {
      order.push(`start ${input.ref}`);
      await delay(input.ref === "A 1" ? 30 : 1); // first tool finishes last
      order.push(`end ${input.ref}`);
      if (name === "search_sefaria") return { results: [] };
      return fakeText(input.ref);
    };
    const client = fakeClient([
      toolTurn(
        toolUse("t0", "get_text", { ref: "A 1" }),
        toolUse("t1", "get_text", { ref: "B 2" }),
        toolUse("t2", "search_sefaria", { query: "x", ref: "C 3" })
      ),
      textTurn("Answer"),
    ]);
    const { promise, names, events } = run(client, { executeTool });
    assert.deepEqual(await promise, { status: "done" });

    assert.deepEqual(
      order.slice(0, 3),
      ["start A 1", "start B 2", "start C 3"],
      "all started first"
    );
    const msgs = client.calls[1].params.messages;
    assert.equal(msgs.length, 3);
    assert.equal(msgs[1].role, "assistant");
    assert.equal(msgs[2].role, "user");
    assert.deepEqual(
      msgs[2].content.map((b) => [b.type, b.tool_use_id]),
      [
        ["tool_result", "t0"],
        ["tool_result", "t1"],
        ["tool_result", "t2"],
      ]
    );
    assert.deepEqual(JSON.parse(msgs[2].content[0].content), fakeText("A 1"));

    assert.deepEqual(names(), ["tool", "tool", "tool", "text", "sources", "done"]);
    assert.deepEqual(events[0][1], { name: "get_text", input: { ref: "A 1" } });
    assert.deepEqual(events[3][1], { delta: "Answer" });
    assert.deepEqual(events[4][1], {
      sources: [
        { ref: "A 1", url: "https://www.sefaria.org/A 1" },
        { ref: "B 2", url: "https://www.sefaria.org/B 2" },
      ],
    });
  });

  it("echoes thinking blocks back unchanged with the tool_use turn", async () => {
    const turn = toolTurn(toolUse("t0", "get_text", { ref: "A 1" }));
    turn.content.unshift({ type: "redacted_thinking", data: "opaque" });
    const client = fakeClient([turn, textTurn("ok")]);
    await run(client).promise;
    assert.deepEqual(client.calls[1].params.messages[1], {
      role: "assistant",
      content: turn.content,
    });
  });

  it("marks tool errors (returned or thrown) with is_error and skips them as sources", async () => {
    const executeTool = async (name, input) => {
      if (input.ref === "Bad 1") return { error: "No text found" };
      if (input.ref === "Boom 1") throw new Error("network down");
      return fakeText(input.ref);
    };
    const client = fakeClient([
      toolTurn(
        toolUse("t0", "get_text", { ref: "Bad 1" }),
        toolUse("t1", "get_text", { ref: "Boom 1" }),
        toolUse("t2", "get_text", { ref: "Good 1" }),
        toolUse("t3", "get_text", { ref: "Good 1" })
      ),
      textTurn("ok"),
    ]);
    const { promise, events } = run(client, { executeTool });
    await promise;
    const results = client.calls[1].params.messages[2].content;
    assert.equal(results[0].is_error, true);
    assert.equal(results[1].is_error, true);
    assert.deepEqual(JSON.parse(results[1].content), { error: "network down" });
    assert.ok(!("is_error" in results[2]));
    const sources = events.find((e) => e[0] === "sources")[1].sources;
    assert.deepEqual(
      sources,
      [{ ref: "Good 1", url: "https://www.sefaria.org/Good 1" }],
      "deduped"
    );
  });

  it("does not emit sources when no texts were fetched", async () => {
    const client = fakeClient([textTurn("just talk")]);
    const { promise, names } = run(client);
    await promise;
    assert.deepEqual(names(), ["text", "done"]);
  });

  it("continues after pause_turn without running tools", async () => {
    const paused = { stop_reason: "pause_turn", content: [thinking("hmm")] };
    const client = fakeClient([paused, textTurn("resumed")]);
    const { promise } = run(client);
    assert.deepEqual(await promise, { status: "done" });
    assert.equal(client.calls.length, 2);
    assert.deepEqual(client.calls[1].params.messages.at(-1), {
      role: "assistant",
      content: paused.content,
    });
  });

  it("forces a final answer with tool_choice none after maxTurns", async () => {
    const t = () => toolTurn(toolUse("t", "get_text", { ref: "A 1" }));
    const client = fakeClient([t(), t(), textTurn("Final")]);
    const { promise } = run(client, { maxTurns: 2 });
    assert.deepEqual(await promise, { status: "done" });
    assert.equal(client.calls.length, 3);
    assert.equal(client.calls[0].params.tool_choice, undefined);
    assert.equal(client.calls[1].params.tool_choice, undefined);
    assert.deepEqual(client.calls[2].params.tool_choice, { type: "none" });
    assert.equal(client.calls[2].params.tools.length, TOOLS.length, "tools still sent");
  });

  it("stops after the final turn even if the model still asks for tools", async () => {
    const t = () => toolTurn(toolUse("t", "get_text", { ref: "A 1" }));
    let calls = 0;
    const client = fakeClient([
      {
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "Let me look. " },
          toolUse("t", "get_text", { ref: "A 1" }),
        ],
      },
      t(),
    ]);
    const { promise, names } = run(client, {
      maxTurns: 1,
      executeTool: async (_n, input) => {
        calls++;
        return fakeText(input.ref);
      },
    });
    assert.deepEqual(await promise, { status: "done" });
    assert.equal(client.calls.length, 2);
    assert.equal(calls, 1, "tools from the final turn are not executed");
    assert.deepEqual(names(), ["text", "tool", "sources", "done"]);
  });

  it("defaults to MAX_AGENT_TURNS + 1 calls at most", async () => {
    const script = Array.from({ length: MAX_AGENT_TURNS + 1 }, () =>
      toolTurn(toolUse("t", "get_text", { ref: "A 1" }))
    );
    script[MAX_AGENT_TURNS] = textTurn("finally");
    const client = fakeClient(script);
    await run(client).promise;
    assert.equal(client.calls.length, MAX_AGENT_TURNS + 1);
  });

  it("emits an error when the model never writes text", async () => {
    const client = fakeClient([
      toolTurn(toolUse("t", "get_text", { ref: "A 1" })),
      { stop_reason: "end_turn", content: [thinking("...")] },
    ]);
    const { promise, events } = run(client);
    assert.deepEqual(await promise, { status: "no_answer" });
    assert.deepEqual(events.at(-1), ["error", { message: NO_ANSWER_MESSAGE }]);
    assert.ok(!events.some((e) => e[0] === "done" || e[0] === "sources"));
  });

  it("emits an error on refusal and stops", async () => {
    const client = fakeClient([{ stop_reason: "refusal", content: [] }, textTurn("never")]);
    const { promise, events } = run(client);
    assert.deepEqual(await promise, { status: "refusal" });
    assert.deepEqual(events, [["error", { message: REFUSAL_MESSAGE }]]);
    assert.equal(client.calls.length, 1);
  });

  it("strips declined-model blocks before a fallback when echoing", async () => {
    const turn = {
      stop_reason: "tool_use",
      content: [
        thinking("declined model"),
        toolUse("old", "get_text", { ref: "Old 1" }),
        { type: "fallback" },
        thinking("fallback model"),
        toolUse("new", "get_text", { ref: "New 1" }),
      ],
    };
    const ran = [];
    const client = fakeClient([turn, textTurn("ok")]);
    await run(client, {
      executeTool: async (_n, input) => {
        ran.push(input.ref);
        return fakeText(input.ref);
      },
    }).promise;
    assert.deepEqual(ran, ["New 1"]);
    assert.deepEqual(
      client.calls[1].params.messages[1].content.map((b) => b.type),
      ["thinking", "tool_use"]
    );
    assert.equal(client.calls[1].params.messages[1].content[0].thinking, "fallback model");
  });

  it("stops without further model calls when aborted during tool execution", async () => {
    const ac = new AbortController();
    const client = fakeClient([
      toolTurn(
        toolUse("t0", "get_text", { ref: "A 1" }),
        toolUse("t1", "get_text", { ref: "B 1" })
      ),
      textTurn("never"),
    ]);
    const seen = [];
    const { promise, names } = run(client, {
      signal: ac.signal,
      executeTool: async (_n, input, { signal }) => {
        seen.push(signal);
        ac.abort();
        return fakeText(input.ref);
      },
    });
    assert.deepEqual(await promise, { status: "aborted" });
    assert.equal(client.calls.length, 1);
    assert.deepEqual(seen, [ac.signal, ac.signal], "tools receive the abort signal");
    assert.ok(!names().includes("done"));
  });

  it("does nothing if already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const client = fakeClient([textTurn("never")]);
    const { promise, events } = run(client, { signal: ac.signal });
    assert.deepEqual(await promise, { status: "aborted" });
    assert.equal(client.calls.length, 0);
    assert.deepEqual(events, []);
  });

  it("propagates stream errors to the caller", async () => {
    const client = fakeClient([new Anthropic.APIConnectionError({ message: "down" })]);
    await assert.rejects(run(client).promise, Anthropic.APIConnectionError);
  });

  it("builds a request the real SDK accepts (beta header, body shape)", async () => {
    let captured;
    const client = new Anthropic({
      apiKey: "test-key",
      maxRetries: 0,
      fetch: async (url, init) => {
        captured = {
          url: String(url),
          headers: new Headers(init.headers),
          body: JSON.parse(init.body),
        };
        throw new Error("stop before network");
      },
    });
    await assert.rejects(
      runAgent({ client, system: SYSTEM, messages: QUESTION, emit: () => {} }),
      Anthropic.APIConnectionError
    );
    assert.match(captured.url, /\/v1\/messages\?beta=true$/);
    assert.equal(captured.headers.get("anthropic-beta"), FALLBACK_BETA);
    assert.equal(captured.body.stream, true);
    assert.equal(captured.body.fallbacks, "default");
    assert.equal(captured.body.model, MODEL);
    assert.ok(!("thinking" in captured.body));
    assert.ok(!("betas" in captured.body), "betas go in the header, not the body");
  });
});

describe("contentForEcho", () => {
  it("returns content unchanged when there is no fallback block", () => {
    const content = [thinking(), toolUse("a", "get_text", {}), { type: "text", text: "x" }];
    assert.equal(contentForEcho(content), content);
  });

  it("drops fallback markers and pre-fallback thinking/tool blocks but keeps text", () => {
    const echoed = contentForEcho([
      thinking("1"),
      { type: "redacted_thinking", data: "r" },
      toolUse("a", "get_text", {}),
      { type: "server_tool_use", id: "s" },
      { type: "text", text: "partial" },
      { type: "fallback" },
      thinking("2"),
      { type: "fallback" },
      thinking("3"),
      toolUse("b", "get_text", {}),
    ]);
    assert.deepEqual(
      echoed.map((b) => b.type + (b.thinking ?? b.id ?? b.text ?? "")),
      ["textpartial", "thinking3", "tool_useb"]
    );
  });
});
