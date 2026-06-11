// Pillow Wrestling with Judaism — chat client

const chatEl = document.getElementById("chat");
const welcomeEl = document.getElementById("welcome");
const railEl = document.getElementById("sageRail");
const blurbEl = document.getElementById("sageBlurb");
const startersEl = document.getElementById("starters");
const form = document.getElementById("composer");
const input = document.getElementById("input");
const sendBtn = document.getElementById("sendBtn");

let sages = [];
let currentSage = null;
let history = []; // [{role, content}] — plain strings only
let busy = false;

// ——— @-mentions ———
// Short label inserted by autocomplete, plus accepted aliases for parsing.
const MENTIONS = {
  "beit-midrash": { label: "Beit Midrash", aliases: ["beit midrash", "the beit midrash", "everyone"] },
  hillel: { label: "Hillel", aliases: ["hillel"] },
  akiva: { label: "Rabbi Akiva", aliases: ["rabbi akiva", "akiva"] },
  rashi: { label: "Rashi", aliases: ["rashi"] },
  rambam: { label: "Rambam", aliases: ["rambam", "maimonides"] },
  ramban: { label: "Ramban", aliases: ["ramban", "nachmanides"] },
  besht: { label: "Baal Shem Tov", aliases: ["the baal shem tov", "baal shem tov", "besht"] },
  buber: { label: "Buber", aliases: ["martin buber", "buber"] },
  heschel: { label: "Heschel", aliases: ["abraham joshua heschel", "heschel"] },
  sacks: { label: "Rabbi Sacks", aliases: ["rabbi jonathan sacks", "jonathan sacks", "rabbi sacks", "sacks"] },
};

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns sage objects mentioned via @, in order of first appearance.
function findMentions(text) {
  const found = [];
  for (const sage of sages) {
    const m = MENTIONS[sage.id];
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
  currentSage = sages[0];
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
  selectSage(currentSage.id);
}

function selectSage(id) {
  currentSage = sages.find((s) => s.id === id) ?? sages[0];
  for (const chip of railEl.children) {
    chip.classList.toggle("active", chip.dataset.id === currentSage.id);
  }
  blurbEl.textContent = `${currentSage.blurb}`;
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
  if (!sources?.length) return;
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
}

function addError(message) {
  const div = document.createElement("div");
  div.className = "error-line";
  div.textContent = `⚠️ ${message}`;
  chatEl.appendChild(div);
}

function scrollDown() {
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

// ——— Ask flow (SSE over fetch) ———

async function ask(question) {
  busy = true;
  sendBtn.disabled = true;
  welcomeEl?.remove();

  const target = resolveTarget(question);

  addUserMessage(question);
  history.push({ role: "user", content: question });
  scrollDown();

  const bodyEl = addSageMessage(target);
  let answer = "";
  const toolLines = [];

  try {
    const res = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sage: target.id, messages: history }),
    });

    if (!res.ok || !res.body) {
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
          answer += payload.delta;
          bodyEl.innerHTML = renderMarkdown(answer);
          scrollDown();
        } else if (event === "tool") {
          toolLines.push(addToolLine(payload.name, payload.input));
        } else if (event === "sources") {
          addSources(payload.sources);
        } else if (event === "error") {
          addError(payload.message);
        }
      }
    }
  } catch (err) {
    addError(err.message || "Connection lost. Try again.");
  } finally {
    while (toolLines.length) toolLines.pop().remove();
    if (answer.trim()) {
      history.push({ role: "assistant", content: answer });
    } else {
      // Nothing came back — don't leave an empty bubble or a dangling user turn
      bodyEl.closest(".msg")?.remove();
      if (history[history.length - 1]?.role === "user") history.pop();
    }
    busy = false;
    sendBtn.disabled = false;
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
    const info = MENTIONS[s.id];
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
              data-id="${s.id}" role="option" style="--accent:${s.color}">
        <span class="mi-emoji">${s.emoji}</span>
        <span class="mi-name">${escapeHtml(MENTIONS[s.id].label)}</span>
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
  const info = MENTIONS[id];
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
  const q = input.value.trim();
  if (!q || busy) return;
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
