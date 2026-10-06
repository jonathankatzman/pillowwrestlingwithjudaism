// The streaming agent loop: Claude + Sefaria tools, reported through an `emit`
// callback so the HTTP layer (SSE) stays separate and the loop is testable with
// a fake client.

import { TOOLS, executeTool as defaultExecuteTool, refToUrl } from "./sefaria.js";

export const MODEL = "claude-sonnet-5-5";
export const MAX_AGENT_TURNS = 8;
export const MAX_TOKENS = 16000;
// Chat app: "medium" balances answer quality against latency/cost. Tunable
// (low | medium | high | xhigh | max). Thinking is always on for this model, so
// `thinking` is omitted (adaptive); `{type: "disabled"}` would be a 400.
export const EFFORT = "medium";
// Server-side refusal fallback, "default" scalar form (Anthropic picks the
// fallback model per refusal category). This exact beta header goes with the
// "default" form; the array form uses a different header.
export const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export const REFUSAL_MESSAGE =
  "The study house can't take up that question as asked. Try rephrasing it, or come at it from another angle.";
export const NO_ANSWER_MESSAGE =
  "The sages talked themselves in circles and never reached an answer. Please try asking again, perhaps more narrowly.";

// Thinking / tool blocks that sit before the last `fallback` block belong to the
// model that declined mid-stream and must not be echoed back to the API.
const PRE_FALLBACK_DROP = new Set(["thinking", "redacted_thinking", "tool_use", "server_tool_use"]);

export function contentForEcho(content) {
  let lastFallback = -1;
  content.forEach((b, i) => {
    if (b.type === "fallback") lastFallback = i;
  });
  if (lastFallback === -1) return content;
  return content.filter(
    (b, i) => b.type !== "fallback" && !(i < lastFallback && PRE_FALLBACK_DROP.has(b.type))
  );
}

/**
 * Run the agent loop.
 * @param {object} opts
 * @param {import("@anthropic-ai/sdk").default} opts.client
 * @param {Array} opts.system  system prompt blocks (cached)
 * @param {Array} opts.messages  validated [{role, content: string}] history; copied, not mutated
 * @param {(event: string, data: object) => void} opts.emit  SSE-style event sink
 * @param {AbortSignal} [opts.signal]  aborts the in-flight stream and stops the loop
 * @returns {Promise<{status: "done" | "refusal" | "no_answer" | "aborted"}>}
 */
export async function runAgent({
  client,
  system,
  messages: history,
  emit,
  signal,
  executeTool = defaultExecuteTool,
  model = MODEL,
  maxTurns = MAX_AGENT_TURNS,
  effort = EFFORT,
  maxTokens = MAX_TOKENS,
}) {
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  const sources = new Map(); // ref -> url, texts actually consulted
  let wroteText = false;

  // Turns 0..maxTurns-1 run normally. If the model still wants tools after
  // that, turn `maxTurns` is a final call with tool_choice "none" so it must
  // answer from what it already gathered.
  for (let turn = 0; turn <= maxTurns; turn++) {
    if (signal?.aborted) return { status: "aborted" };
    const finalTurn = turn === maxTurns;

    const stream = client.beta.messages.stream(
      {
        model,
        max_tokens: maxTokens,
        system,
        tools: TOOLS,
        ...(finalTurn ? { tool_choice: { type: "none" } } : {}),
        output_config: { effort },
        betas: [FALLBACK_BETA],
        fallbacks: "default",
        messages,
      },
      { signal }
    );

    // The "text" event only carries text_delta (never thinking), which is what we want.
    stream.on("text", (delta) => {
      if (!delta) return;
      wroteText = true;
      emit("text", { delta });
    });

    const message = await stream.finalMessage();
    if (signal?.aborted) return { status: "aborted" };

    if (message.stop_reason === "refusal") {
      // Whole fallback chain declined (or the category isn't retried server-side).
      emit("error", { message: REFUSAL_MESSAGE });
      return { status: "refusal" };
    }

    const content = contentForEcho(message.content);

    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content });
      continue;
    }

    const toolUses = content.filter((b) => b.type === "tool_use");
    if (message.stop_reason !== "tool_use" || toolUses.length === 0 || finalTurn) break;

    // Push the full content back unchanged (thinking blocks included).
    messages.push({ role: "assistant", content });

    for (const block of toolUses) emit("tool", { name: block.name, input: block.input });

    // Run this turn's tools in parallel; results come back in tool_use order.
    const results = await Promise.all(
      toolUses.map(async (block) => {
        try {
          return await executeTool(block.name, block.input, { signal });
        } catch (err) {
          return { error: String(err?.message ?? err) };
        }
      })
    );
    if (signal?.aborted) return { status: "aborted" };

    // Record sources in tool_use order (not completion order) so the list is stable.
    toolUses.forEach((block, i) => {
      const result = results[i];
      if (block.name === "get_text" && result?.ref && !result.error && !sources.has(result.ref)) {
        sources.set(result.ref, result.url ?? refToUrl(result.ref));
      }
    });

    // All results for this turn, in order, in a single user message.
    messages.push({
      role: "user",
      content: toolUses.map((block, i) => ({
        type: "tool_result",
        tool_use_id: block.id,
        content: JSON.stringify(results[i] ?? null),
        ...(results[i]?.error ? { is_error: true } : {}),
      })),
    });
  }

  if (!wroteText) {
    emit("error", { message: NO_ANSWER_MESSAGE });
    return { status: "no_answer" };
  }

  if (sources.size > 0) {
    emit("sources", {
      sources: [...sources.entries()].map(([ref, url]) => ({ ref, url })),
    });
  }
  emit("done", {});
  return { status: "done" };
}
