// Shared test fakes (no tests in this file).
import Anthropic from "@anthropic-ai/sdk";

/**
 * A fake Anthropic client whose `beta.messages.stream()` replays a script of
 * final messages. Text blocks are emitted as "text" events before finalMessage
 * resolves, like the real BetaMessageStream.
 */
export function fakeClient(script) {
  const calls = [];
  const client = {
    calls,
    beta: {
      messages: {
        stream(params, opts) {
          calls.push({ params: structuredClone(params), opts });
          const step = script[calls.length - 1];
          if (!step) throw new Error(`fake client: no scripted response for call ${calls.length}`);
          const handlers = {};
          return {
            on(ev, fn) {
              (handlers[ev] ??= []).push(fn);
              return this;
            },
            async finalMessage() {
              if (opts?.signal?.aborted) throw new Anthropic.APIUserAbortError();
              if (step instanceof Error) throw step;
              for (const b of step.content) {
                if (b.type === "text") for (const fn of handlers.text ?? []) fn(b.text, b.text);
              }
              return step;
            },
          };
        },
      },
    },
  };
  return client;
}

export const thinking = (text = "") => ({ type: "thinking", thinking: text, signature: "sig" });

export const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

export const toolTurn = (...uses) => ({
  stop_reason: "tool_use",
  content: [thinking("let me look"), ...uses],
});

export const textTurn = (text, stop_reason = "end_turn") => ({
  stop_reason,
  content: [thinking("done"), { type: "text", text }],
});

export function collector() {
  const events = [];
  const emit = (event, data) => events.push([event, data]);
  return { events, emit, names: () => events.map((e) => e[0]) };
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** A JSON fetch Response stub. */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
