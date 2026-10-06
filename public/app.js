// Pillow Wrestling with Judaism — chat client

const chatEl = document.getElementById("chat");
const welcomeEl = document.getElementById("welcome");
const chatToolsEl = document.getElementById("chatTools");
const newChatBtn = document.getElementById("newChatBtn");
const railEl = document.getElementById("sageRail");
const blurbEl = document.getElementById("sageBlurb");
const startersEl = document.getElementById("starters");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");

let sages = [];
let currentSage = null;
// [{role, content, sage?, sources?}] — role/content go to the server;
// sage (id) and sources are kept so assistant turns can be re-rendered.
let history = [];
let busy = false;
let controller = null; // AbortController for the in-flight /api/ask

const MAX_SENT_MESSAGES = 30;   // matches the server's history cap
const MAX_MESSAGE_CHARS = 4000; // matches the server's per-message cap
const MAX_STORED_MESSAGES = 200;

// ——— Persistence ———
// Everything goes through try/catch: private mode, blocked storage or a
// full quota must never break the conversation itself.

const STORE_KEY = "pwwj:v1";

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function saveStore() {
  try {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        sage: currentSage?.id ?? null,
        messages: history.slice(-MAX_STORED_MESSAGES),
      })
    );
  } catch {
    // storage unavailable — the conversation just won't survive a reload
  }
}

function cleanSources(list) {
  if (!Array.isArray(list)) return [];
  return list.filter(
    (s) => s && typeof s.ref === "string" && typeof s.url === "string" && /^https?:\/\//i.test(s.url)
  );
}

function cleanStoredMessages(list) {
  if (!Array.isArray(list)) return [];
  const msgs = list
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content)
    .map((m) =>
      m.role === "user"
        ? { role: "user", content: m.content }
        : { role: "assistant", content: m.content, sage: typeof m.sage === "string" ? m.sage : null, sources: cleanSources(m.sources) }
    );
  // An unanswered question at the end is a turn that never finished
  while (msgs.length && msgs[msgs.length - 1].role === "user") msgs.pop();
  return msgs;
}

// The most recent slice of history, trimmed to what the server accepts
function outgoingMessages() {
  const msgs = history
    .slice(-MAX_SENT_MESSAGES)
    .map(({ role, content }) => ({ role, content: content.slice(0, MAX_MESSAGE_CHARS) }));
  while (msgs.length && msgs[0].role !== "user") msgs.shift();
  return msgs;
}

// ——— @-mentions ———
// Each sage from /api/sages carries mention: { label, aliases } — the short
// label inserted by autocomplete, plus accepted aliases for parsing.

function mentionOf(sage) {
  const m = sage?.mention;
  if (m && typeof m.label === "string" && m.label) {
    return { label: m.label, aliases: Array.isArray(m.aliases) ? m.aliases.filter((a) => typeof a === "string" && a) : [] };
  }
  return null;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns sage objects mentioned via @, in order of first appearance.
function findMentions(text) {
  const found = [];
  for (const sage of sages) {
    const m = mentionOf(sage);
    if (!m) continue;
    const pattern = new RegExp(
      "@(?:" + [m.label, ...m.aliases].map(escapeRegExp).join("|") + ")(?![\\w])",
      "i"
    );
    const match = text.match(pattern);
    if (match) found.push({ sage, index: match.index });
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.sage);
}

// Decide who answers this message: one mention → that sage;
// several → the Beit Midrash convenes; none → the picker's choice.
function resolveTarget(text) {
  const mentioned = findMentions(text);
  if (mentioned.length === 1) return mentioned[0];
  if (mentioned.length > 1) return sages.find((s) => s.id === "beit-midrash") ?? currentSage;
  return currentSage;
}

const STARTERS = [
  "Why does God let bad things happen to good people?",
  "Is it okay to be angry at God?",
  "What does Judaism say about AI?",
  "I don't believe in God. Can I still be Jewish?",
  "How do I forgive someone who isn't sorry?",
  "What's the point of keeping Shabbat in 2026?",
  "Does Judaism believe in an afterlife?",
  "How much of my money am I supposed to give away?",
];

// ——— Sage picker ———

async function loadSages() {
  const res = await fetch("/api/sages");
  sages = await res.json();
  const saved = loadStore();
  currentSage = sages.find((s) => s.id === saved?.sage) ?? sages[0];
  railEl.innerHTML = "";
  for (const sage of sages) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = sage.id === "beit-midrash" ? "sage-chip rainbow" : "sage-chip";
    chip.dataset.id = sage.id;
    if (sage.color) chip.style.setProperty("--accent", sage.color);
    chip.setAttribute("role", "option");
    chip.innerHTML = `
      <span class="chip-name">${sage.emoji} ${escapeHtml(sage.name)}</span>
      <span class="chip-era">${escapeHtml(sage.years)}</span>`;
    chip.addEventListener("click", () => selectSage(sage.id));
    railEl.appendChild(chip);
  }
  // Restore first — selectSage() saves, and must not overwrite the stored chat
  restoreConversation(saved);
  selectSage(currentSage.id);
}

function selectSage(id) {
  currentSage = sages.find((s) => s.id === id) ?? sages[0];
  for (const chip of railEl.children) {
    chip.classList.toggle("active", chip.dataset.id === currentSage.id);
  }
  blurbEl.textContent = `${currentSage.blurb}`;
  saveStore();
}

// A sage who answered in a saved conversation may since have left the table
function sageById(id) {
  return (
    sages.find((s) => s.id === id) ?? {
      id: id ?? "unknown",
      name: "A sage",
      emoji: "📜",
      years: "",
      era: "",
      color: "",
    }
  );
}

// ——— Starters ———

for (const q of STARTERS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "starter";
  b.textContent = q;
  b.addEventListener("click", () => {
    input.value = q;
    form.requestSubmit();
  });
  startersEl.appendChild(b);
}

// ——— Rendering ———

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Minimal, safe markdown: escape first, then re-introduce a few constructs.
function renderMarkdown(text) {
  const lines = escapeHtml(text).split("\n");
  const out = [];
  let para = [];
  let list = null; // "ul" | "ol"

  const closePara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join(" "))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) { closePara(); closeList(); continue; }

    if (trimmed.startsWith("&gt;")) {
      closePara(); closeList();
      out.push(`<blockquote>${inline(trimmed.replace(/^(&gt;\s*)+/, ""))}</blockquote>`);
      continue;
    }
    const ulMatch = trimmed.match(/^[-*]\s+(.*)/);
    const olMatch = trimmed.match(/^\d+[.)]\s+(.*)/);
    if (ulMatch || olMatch) {
      closePara();
      const want = ulMatch ? "ul" : "ol";
      if (list !== want) { closeList(); out.push(`<${want}>`); list = want; }
      out.push(`<li>${inline((ulMatch ?? olMatch)[1])}</li>`);
      continue;
    }
    const heading = trimmed.match(/^#{1,4}\s+(.*)/);
    if (heading) {
      closePara(); closeList();
      out.push(`<p><strong>${inline(heading[1])}</strong></p>`);
      continue;
    }
    closeList();
    para.push(trimmed);
  }
  closePara();
  closeList();
  return out.join("");
}

function inline(s) {
  return s
    // links: [text](url) — http(s) only
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>");
}

function addUserMessage(text) {
  const div = document.createElement("div");
  div.className = "msg user";
  div.innerHTML = `<div class="msg-body">${renderMarkdown(text)}</div>`;
  chatEl.appendChild(div);
  return div;
}

function addSageMessage(sage) {
  const div = document.createElement("div");
  div.className = "msg sage";
  if (sage.color) div.style.setProperty("--accent", sage.color);
  div.innerHTML = `
    <div class="msg-byline"><span class="who">${sage.emoji} ${escapeHtml(sage.name)}</span>
    <span class="when">${escapeHtml(sage.era === "panel" ? "in session" : sage.years)}</span></div>
    <div class="msg-body"></div>`;
  chatEl.appendChild(div);
  return div.querySelector(".msg-body");
}

function addToolLine(name, inputData) {
  const div = document.createElement("div");
  div.className = "tool-line";
  let label = "Consulting the library…";
  if (name === "search_sefaria") label = `Searching Sefaria for “${inputData?.query ?? "…"}”`;
  else if (name === "get_text") label = `Opening ${inputData?.ref ?? "a text"}…`;
  else if (name === "get_commentaries") label = `Pulling commentaries on ${inputData?.ref ?? "the verse"}…`;
  div.innerHTML = `<span class="dot"></span><span>${escapeHtml(label)}</span>`;
  chatEl.appendChild(div);
  scrollDown();
  return div;
}

function addSources(sources) {
  sources = cleanSources(sources);
  if (!sources.length) return null;
  const div = document.createElement("div");
  div.className = "sources";
  div.innerHTML =
    `<span class="sources-label">Texts consulted</span>` +
    sources
      .map(
        (s) =>
          `<a class="source-chip" href="${escapeHtml(s.url)}" target="_blank" rel="noopener">${escapeHtml(s.ref)}</a>`
      )
      .join("");
  chatEl.appendChild(div);
  return div;
}

// Error line, optionally with a Retry button that runs onRetry once
function addError(message, onRetry) {
  const div = document.createElement("div");
  div.className = "error-line";
  const text = document.createElement("span");
  text.textContent = `⚠️ ${message}`;
  div.appendChild(text);
  if (onRetry) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "retry-btn";
    btn.textContent = "↻ Retry";
    btn.addEventListener("click", () => {
      if (busy) return;
      div.remove();
      onRetry();
    });
    div.appendChild(btn);
  }
  chatEl.appendChild(div);
  return div;
}

// Only the latest failure can be retried — older Retry buttons go away
function clearRetryButtons() {
  for (const btn of chatEl.querySelectorAll(".retry-btn")) btn.remove();
}

function scrollDown() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

// ——— Conversation state ———

function updateChatTools() {
  chatToolsEl.hidden = history.length === 0 && !chatEl.querySelector(".msg");
  newChatBtn.disabled = busy;
}

function restoreConversation(saved) {
  const msgs = cleanStoredMessages(saved?.messages);
  if (!msgs.length) return;
  history = msgs;
  welcomeEl.remove();
  for (const m of history) {
    if (m.role === "user") {
      addUserMessage(m.content);
    } else {
      addSageMessage(sageById(m.sage)).innerHTML = renderMarkdown(m.content);
      addSources(m.sources);
    }
  }
  updateChatTools();
  window.scrollTo({ top: document.body.scrollHeight });
}

function newConversation() {
  if (busy) return;
  history = [];
  for (const el of [...chatEl.children]) {
    if (el !== chatToolsEl) el.remove();
  }
  chatEl.appendChild(welcomeEl);
  saveStore();
  updateChatTools();
  window.scrollTo({ top: 0, behavior: "smooth" });
  input.focus();
}

newChatBtn.addEventListener("click", newConversation);

// ——— Send / stop button ———

const SEND_ICON = sendBtn.innerHTML;
const STOP_ICON =
  '<svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor"/></svg>';

function setStreaming(on) {
  sendBtn.classList.toggle("stop", on);
  sendBtn.innerHTML = on ? STOP_ICON : SEND_ICON;
  sendBtn.setAttribute("aria-label", on ? "Stop" : "Send");
  sendBtn.title = on ? "Stop" : "";
}

// While streaming, the button stops the answer instead of submitting
sendBtn.addEventListener("click", (e) => {
  if (!busy) return;
  e.preventDefault();
  controller?.abort();
});

// ——— Ask flow (SSE over fetch) ———

// retry: { target } when re-asking a failed question — the user bubble is
// already on screen, so it isn't added again.
async function ask(question, retry = null) {
  busy = true;
  setStreaming(true);
  clearRetryButtons();
  welcomeEl.remove();

  const target = retry?.target ?? resolveTarget(question);

  if (!retry) addUserMessage(question);
  history.push({ role: "user", content: question });
  updateChatTools();
  scrollDown();

  const bodyEl = addSageMessage(target);
  const turnEls = [bodyEl.closest(".msg")]; // everything this answer drew
  let answer = "";
  let sources = [];
  let failure = null; // error message, if the request failed
  const toolLines = [];
  controller = new AbortController();

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sage: target.id, messages: outgoingMessages() }),
      signal: controller.signal,
    });

    if (!res.ok || !res.body) {
      // e.g. 400 (bad request) or 429 (rate limit) with JSON { error }
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let sep;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);

        let event = "message";
        let data = "";
        for (const line of chunk.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7).trim();
          else if (line.startsWith("data: ")) data += line.slice(6);
        }
        if (!data) continue;
        let payload;
        try { payload = JSON.parse(data); } catch { continue; }

        if (event === "text") {
          // The sage has begun speaking — clear "searching…" lines
          while (toolLines.length) toolLines.pop().remove();
          answer += payload.delta ?? "";
          bodyEl.innerHTML = renderMarkdown(answer);
          scrollDown();
        } else if (event === "tool") {
          toolLines.push(addToolLine(payload.name, payload.input));
        } else if (event === "sources") {
          sources = cleanSources(payload.sources);
          const el = addSources(sources);
          if (el) turnEls.push(el);
        } else if (event === "error") {
          failure = payload.message || "Something went wrong.";
        }
      }
    }
  } catch (err) {
    // A user-initiated stop isn't an error — keep whatever arrived
    if (err.name !== "AbortError") failure = err.message || "Connection lost. Try again.";
  } finally {
    controller = null;
    while (toolLines.length) toolLines.pop().remove();
    let answerTurn = null;
    if (answer.trim()) {
      answerTurn = { role: "assistant", content: answer, sage: target.id, sources };
      history.push(answerTurn);
    } else {
      // Nothing came back — don't leave an empty bubble or a dangling user turn
      for (const el of turnEls) el.remove();
      if (history[history.length - 1]?.role === "user") history.pop();
    }

    if (failure) {
      addError(failure, () => {
        // Discard any partial answer so the retry replaces it cleanly
        if (answerTurn && history[history.length - 1] === answerTurn) {
          for (const el of turnEls) el.remove();
          history.pop(); // the partial answer
          history.pop(); // its question — ask() pushes it again
        }
        ask(question, { target });
      });
    }

    saveStore();
    busy = false;
    setStreaming(false);
    updateChatTools();
    scrollDown();
    input.focus();
  }
}

// ——— Mention autocomplete ———

const menuEl = document.getElementById("mentionMenu");
let menuItems = []; // [{sage, start}] currently shown
let menuIndex = 0;
let mentionStart = -1; // index of "@" being completed

function closeMentionMenu() {
  menuEl.hidden = true;
  menuItems = [];
  mentionStart = -1;
}

function updateMentionMenu() {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const m = before.match(/(?:^|[\s.,;!?])@([a-zA-Z ]{0,25})$/);
  if (!m) return closeMentionMenu();

  const query = m[1].toLowerCase().trimStart();
  mentionStart = caret - m[1].length - 1; // position of "@"

  const matches = sages.filter((s) => {
    const info = mentionOf(s);
    if (!info) return false;
    if (!query) return true;
    // Match the start of the alias or of any word within it ("ra" → Rashi,
    // Rambam, Rabbi Akiva — but not Beit Mid*ra*sh or Ab*ra*ham Heschel)
    return [info.label, ...info.aliases, s.name].some((a) =>
      a.toLowerCase().split(/\s+/).some((word) => word.startsWith(query))
    );
  });
  if (!matches.length) return closeMentionMenu();

  menuItems = matches;
  menuIndex = 0;
  menuEl.innerHTML = matches
    .map(
      (s, i) => `
      <button type="button" class="mention-item${i === 0 ? " selected" : ""}"
              data-id="${escapeHtml(s.id)}" role="option" style="--accent:${escapeHtml(s.color ?? "")}">
        <span class="mi-emoji">${s.emoji}</span>
        <span class="mi-name">${escapeHtml(mentionOf(s).label)}</span>
        <span class="mi-era">${escapeHtml(s.years)}</span>
      </button>`
    )
    .join("");
  menuEl.hidden = false;
  for (const btn of menuEl.querySelectorAll(".mention-item")) {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault(); // keep focus in the textarea
      pickMention(btn.dataset.id);
    });
  }
}

function pickMention(id) {
  const info = mentionOf(sages.find((s) => s.id === id));
  if (!info || mentionStart < 0) return closeMentionMenu();
  const caret = input.selectionStart ?? input.value.length;
  input.value =
    input.value.slice(0, mentionStart) + "@" + info.label + " " + input.value.slice(caret);
  const newCaret = mentionStart + info.label.length + 2;
  input.setSelectionRange(newCaret, newCaret);
  closeMentionMenu();
  input.focus();
}

function moveMenuSelection(delta) {
  menuIndex = (menuIndex + delta + menuItems.length) % menuItems.length;
  menuEl.querySelectorAll(".mention-item").forEach((el, i) => {
    el.classList.toggle("selected", i === menuIndex);
    if (i === menuIndex) el.scrollIntoView({ block: "nearest" });
  });
}

// ——— Composer ———

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const q = input.value.trim().slice(0, MAX_MESSAGE_CHARS);
  if (!q || busy || !currentSage) return;
  closeMentionMenu();
  input.value = "";
  input.style.height = "auto";
  ask(q);
});

input.addEventListener("keydown", (e) => {
  if (!menuEl.hidden) {
    if (e.key === "ArrowDown") { e.preventDefault(); return moveMenuSelection(1); }
    if (e.key === "ArrowUp") { e.preventDefault(); return moveMenuSelection(-1); }
    if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      return pickMention(menuItems[menuIndex]?.id);
    }
    if (e.key === "Escape") { e.preventDefault(); return closeMentionMenu(); }
  }
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 160) + "px";
  updateMentionMenu();
});

input.addEventListener("blur", () => setTimeout(closeMentionMenu, 150));

// Shorter placeholder where the long one would clip
const narrow = window.matchMedia("(max-width: 560px)");
function fitPlaceholder() {
  input.placeholder = narrow.matches
    ? "Ask anything — or @ a sage…"
    : "Ask anything — or summon someone with @ (try @Rashi)…";
}
narrow.addEventListener("change", fitPlaceholder);
fitPlaceholder();

loadSages().catch(() => {
  blurbEl.textContent = "Couldn't load the sages — is the server running? (npm start)";
});
