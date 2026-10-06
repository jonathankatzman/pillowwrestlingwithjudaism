// Validation + capping for the /api/ask request body. Pure function, no I/O.

export const LIMITS = {
  maxMessages: 30, // keep only the most recent N messages
  maxMessageChars: 4000, // per message: a longer user message is a 400; older assistant answers are truncated
  maxTotalChars: 40_000, // across the kept history; oldest turns are dropped to fit
};

const TRUNCATION_MARK = " […]";

/**
 * Validate and cap the chat history. The client keeps the whole conversation and
 * resends it every time, so long-but-legitimate chats are trimmed (oldest first)
 * rather than rejected; only malformed input or an oversize user message is a 400.
 *
 * @param {unknown} body  parsed JSON body
 * @param {{sageIds: string[], defaultSage?: string, limits?: typeof LIMITS}} opts
 * @returns {{ok: true, sage: string, messages: {role: "user"|"assistant", content: string}[]} | {ok: false, error: string}}
 */
export function validateAskBody(body, { sageIds, defaultSage = "beit-midrash", limits = LIMITS }) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "JSON body required" };
  }
  const { sage = defaultSage, messages: history } = body;

  if (typeof sage !== "string" || !sageIds.includes(sage)) {
    return { ok: false, error: "unknown sage" };
  }
  if (!Array.isArray(history) || history.length === 0) {
    return { ok: false, error: "messages array required" };
  }

  const cleaned = [];
  for (const m of history) {
    if (
      !m ||
      typeof m !== "object" ||
      (m.role !== "user" && m.role !== "assistant") ||
      typeof m.content !== "string"
    ) {
      return {
        ok: false,
        error: "each message needs role 'user' or 'assistant' and string content",
      };
    }
    if (m.content.trim()) cleaned.push({ role: m.role, content: m.content });
  }

  // Keep the most recent messages.
  let messages = cleaned.slice(-limits.maxMessages);

  for (const m of messages) {
    if (m.content.length <= limits.maxMessageChars) continue;
    if (m.role === "user") {
      return { ok: false, error: `message too long (max ${limits.maxMessageChars} characters)` };
    }
    m.content =
      m.content.slice(0, limits.maxMessageChars - TRUNCATION_MARK.length) + TRUNCATION_MARK;
  }

  // Drop oldest messages until the total fits (the last message alone always fits,
  // since it is a user message within maxMessageChars).
  let total = messages.reduce((n, m) => n + m.content.length, 0);
  while (total > limits.maxTotalChars && messages.length > 1) {
    total -= messages[0].content.length;
    messages = messages.slice(1);
  }

  // The history must start with a user turn.
  while (messages.length && messages[0].role !== "user") messages = messages.slice(1);

  if (messages.length === 0) {
    return { ok: false, error: "messages must include a user question" };
  }
  if (messages[messages.length - 1].role !== "user") {
    return { ok: false, error: "last message must be from the user" };
  }
  if (total > limits.maxTotalChars) {
    return { ok: false, error: `conversation too long (max ${limits.maxTotalChars} characters)` };
  }

  return { ok: true, sage, messages };
}
