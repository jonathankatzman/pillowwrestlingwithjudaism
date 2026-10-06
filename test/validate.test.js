import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { validateAskBody, LIMITS } from "../lib/validate.js";

const sageIds = ["beit-midrash", "hillel"];
const v = (body, opts = {}) => validateAskBody(body, { sageIds, ...opts });
const user = (content) => ({ role: "user", content });
const assistant = (content) => ({ role: "assistant", content });

describe("validateAskBody: accepts", () => {
  it("a single user question with the default sage", () => {
    assert.deepEqual(v({ messages: [user("Why wrestle?")] }), {
      ok: true,
      sage: "beit-midrash",
      messages: [user("Why wrestle?")],
    });
  });

  it("an explicit sage and a multi-turn history, stripping extra fields", () => {
    const out = v({
      sage: "hillel",
      messages: [{ ...user("a"), extra: 1 }, { ...assistant("b"), sources: [] }, user("c")],
    });
    assert.equal(out.ok, true);
    assert.equal(out.sage, "hillel");
    assert.deepEqual(out.messages, [user("a"), assistant("b"), user("c")]);
  });

  it("drops blank messages", () => {
    const out = v({ messages: [user("a"), assistant("   "), user("b")] });
    assert.deepEqual(out.messages, [user("a"), user("b")]);
  });

  it("does not mutate the input", () => {
    const long = assistant("x".repeat(LIMITS.maxMessageChars + 10));
    const body = { messages: [user("a"), long, user("b")] };
    const snapshot = structuredClone(body);
    v(body);
    assert.deepEqual(body, snapshot);
  });
});

describe("validateAskBody: trims long history", () => {
  it("keeps only the most recent maxMessages, starting with a user turn", () => {
    const history = Array.from({ length: 41 }, (_, i) =>
      i % 2 ? assistant(`a${i}`) : user(`u${i}`)
    );
    const out = v({ messages: history });
    assert.equal(out.ok, true);
    assert.ok(out.messages.length <= LIMITS.maxMessages);
    assert.equal(out.messages[0].role, "user");
    assert.deepEqual(out.messages.at(-1), user("u40"));
  });

  it("truncates over-long assistant messages with a marker", () => {
    const out = v({ messages: [user("q"), assistant("y".repeat(9000)), user("again")] });
    assert.equal(out.ok, true);
    assert.equal(out.messages[1].content.length, LIMITS.maxMessageChars);
    assert.ok(out.messages[1].content.endsWith(" […]"));
  });

  it("drops oldest turns until the total fits", () => {
    const history = [];
    for (let i = 0; i < 14; i++) history.push(user("u".repeat(100)), assistant("a".repeat(3900)));
    history.push(user("last"));
    const out = v({ messages: history });
    assert.equal(out.ok, true);
    const total = out.messages.reduce((n, m) => n + m.content.length, 0);
    assert.ok(total <= LIMITS.maxTotalChars, `total ${total}`);
    assert.equal(out.messages[0].role, "user");
    assert.deepEqual(out.messages.at(-1), user("last"));
  });

  it("respects custom limits", () => {
    const limits = { maxMessages: 3, maxMessageChars: 10, maxTotalChars: 15 };
    const out = v(
      { messages: [user("1"), assistant("2"), user("3"), assistant("4444444444"), user("55555")] },
      { limits }
    );
    assert.deepEqual(out.messages, [user("55555")]);
  });
});

describe("validateAskBody: rejects", () => {
  const cases = [
    ["missing body", undefined, /JSON body required/],
    ["array body", [], /JSON body required/],
    ["string body", "hi", /JSON body required/],
    ["unknown sage", { sage: "moses", messages: [user("q")] }, /unknown sage/],
    ["non-string sage", { sage: 1, messages: [user("q")] }, /unknown sage/],
    ["missing messages", {}, /messages array required/],
    ["empty messages", { messages: [] }, /messages array required/],
    ["bad role", { messages: [{ role: "system", content: "x" }] }, /role 'user' or 'assistant'/],
    ["non-string content", { messages: [{ role: "user", content: ["x"] }] }, /string content/],
    ["null message", { messages: [null] }, /role/],
    ["only blank messages", { messages: [user("  ")] }, /must include a user question/],
    ["only assistant messages", { messages: [assistant("hi")] }, /must include a user question/],
    [
      "last message from assistant",
      { messages: [user("q"), assistant("a")] },
      /last message must be from the user/,
    ],
    [
      "over-long user message",
      { messages: [user("x".repeat(LIMITS.maxMessageChars + 1))] },
      /message too long \(max 4000/,
    ],
  ];
  for (const [name, body, re] of cases) {
    it(name, () => {
      const out = v(body);
      assert.equal(out.ok, false);
      assert.match(out.error, re);
    });
  }
});
