import Anthropic from "./vendor/anthropic-sdk.js";
import { serverTools, clientTools } from "./tools.js";

// ── 設定 ─────────────────────────────────────────────────────
const MODELS = {
  "claude-opus-5-5": { label: "Opus 5.5", modern: true, fallbacks: true },
  "claude-sonnet-5-5": { label: "Sonnet 5.5", modern: true, fallbacks: true },
  "claude-haiku-5-5": { label: "Haiku 5.5", modern: false, fallbacks: false },
};
const EFFORTS = { low: "浅く（速い）", medium: "ふつう", high: "深く（遅い）" };
const DEFAULT_SYSTEM = [
  "あなたはiPhoneで使われるアシスタント「Pocket Claude」です。",
  "相手と同じ言語で、スマホの画面で読みやすいように簡潔に答えてください。前置きは不要です。",
  "ニュース・天気・価格など時間で変わる情報は、Web検索が使えるときは調べてから答え、根拠にしたサイトを示してください。",
].join("\n");
const MAX_STEPS = 20;

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch { return false; }
  },
};

let settings = Object.assign(
  { model: "claude-opus-5-5", effort: "medium", system: DEFAULT_SYSTEM, tools: {} },
  store.get("pc-settings", {}),
);
if (!MODELS[settings.model]) settings.model = "claude-opus-5-5";
let apiKey = store.get("pc-key", "");
let history = store.get("pc-history", []); // Messages API の messages そのもの
let notices = [];   // 画面だけに出すお知らせ（履歴には入らない）
let busy = false;
let stopRequested = false;
let currentStream = null;
let live = null;    // ストリーミング中のアシスタント応答のスナップショット
let statusText = "";

// ── DOM ──────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const els = {
  thread: $("thread"), list: $("list"), welcome: $("welcome"), notices: $("notices"),
  form: $("composer"), input: $("input"), send: $("send"), stop: $("stop"),
  newChat: $("newChat"), openSettings: $("openSettings"), modelBadge: $("modelBadge"),
  dialog: $("settings"), apiKey: $("apiKey"), showKey: $("showKey"), model: $("model"),
  effort: $("effort"), toolList: $("toolList"), system: $("system"),
  resetSystem: $("resetSystem"), clearAll: $("clearAll"), keyState: $("keyState"),
  closeSettings: $("closeSettings"),
};

const toolOn = (key, def) => settings.tools[key] ?? def.enabled !== false;
const labelFor = (name) => (clientTools.find((t) => t.name === name) || {}).label || name;

function persistSettings() { store.set("pc-settings", settings); }
function persistHistory() {
  if (!store.set("pc-history", history)) {
    addNotice("会話が大きくなったため、この端末に保存できませんでした。表示中の会話はそのまま使えます。", "info");
  }
}

// ── API リクエスト ────────────────────────────────────────────
function buildRequest() {
  const model = MODELS[settings.model];
  const tools = [
    ...serverTools.filter((t) => toolOn(t.id, t)).map((t) => t.build(model.modern)),
    ...clientTools.filter((t) => toolOn(t.name, t)).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
      eager_input_streaming: true,
    })),
  ];
  const req = {
    model: settings.model,
    max_tokens: 64000,
    system: settings.system.trim() || DEFAULT_SYSTEM,
    messages: history.slice(),
    cache_control: { type: "ephemeral" },
    output_config: { effort: settings.effort },
  };
  if (tools.length) req.tools = tools;
  if (model.fallbacks) {
    // 安全フィルターで断られたとき、サーバー側で推奨の別モデルに引き継ぐ
    req.betas = ["server-side-fallback-2026-07-01"];
    req.fallbacks = "default";
  }
  return req;
}

// JSON Schema の最低限のチェック（eager_input_streaming では入力が検証されないため）
function validate(schema, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input is not an object";
  for (const key of schema.required || []) {
    if (!(key in input)) return `missing required field: ${key}`;
  }
  for (const [key, value] of Object.entries(input)) {
    const prop = (schema.properties || {})[key];
    if (!prop) continue;
    const t = prop.type;
    const ok =
      t === "string" ? typeof value === "string" :
      t === "number" ? typeof value === "number" && Number.isFinite(value) :
      t === "integer" ? Number.isInteger(value) :
      t === "boolean" ? typeof value === "boolean" :
      t === "array" ? Array.isArray(value) :
      t === "object" ? value && typeof value === "object" && !Array.isArray(value) :
      true;
    if (!ok) return `field ${key} should be ${t}`;
    if (prop.enum && !prop.enum.includes(value)) return `field ${key} must be one of ${prop.enum.join(", ")}`;
  }
  return null;
}

async function runClientTool(block) {
  const base = { type: "tool_result", tool_use_id: block.id };
  const def = clientTools.find((t) => t.name === block.name);
  if (!def || !toolOn(def.name, def)) return { ...base, is_error: true, content: `Tool ${block.name} is not available.` };
  const problem = validate(def.input_schema, block.input);
  if (problem) {
    return { ...base, is_error: true, content: JSON.stringify({ INVALID_JSON: JSON.stringify(block.input ?? null), problem }) };
  }
  try {
    const out = await def.run(block.input);
    return { ...base, content: typeof out === "string" ? out : JSON.stringify(out) };
  } catch (e) {
    return { ...base, is_error: true, content: String((e && e.message) || e) };
  }
}

async function runTurn() {
  busy = true;
  stopRequested = false;
  syncComposer();
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 2 });
  let jsonRetries = 0;
  let steps = 0;
  try {
    while (!stopRequested) {
      if (++steps > MAX_STEPS) {
        addNotice("ツールの呼び出しが多すぎるため、いったん止めました。続ける場合は「続けて」と送ってください。", "info");
        break;
      }
      setStatus("考えています…");
      const stream = client.beta.messages.stream(buildRequest());
      currentStream = stream;
      stream.on("streamEvent", (_event, snapshot) => { live = snapshot; scheduleTail(); });

      let message;
      try {
        message = await stream.finalMessage();
        jsonRetries = 0;
      } catch (err) {
        live = null;
        if (err instanceof Anthropic.APIUserAbortError) break;
        if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
        continue; // ツール入力のJSONが読めなかった → 同じターンをやり直す
      } finally {
        currentStream = null;
      }
      live = null;

      if (message.stop_reason === "refusal") {
        // 断られた途中の出力は履歴に残さない
        addNotice("この内容にはお答えできませんでした。聞き方を変えてみてください。", "warn");
        break;
      }
      const toolUses = message.content.filter((b) => b.type === "tool_use");
      if (message.stop_reason === "max_tokens" && toolUses.length) {
        addNotice("応答が長すぎて途中で切れたため、ツールは実行しませんでした。", "warn");
        break;
      }

      history.push({ role: "assistant", content: message.content });
      persistHistory();
      render();

      if (message.stop_reason === "pause_turn") continue; // サーバーツールの続き
      if (!toolUses.length) {
        if (message.stop_reason === "max_tokens") addNotice("応答が長すぎて途中で切れました。", "info");
        break;
      }

      setStatus(`${toolUses.map((b) => labelFor(b.name)).join("・")} を実行中…`);
      const results = await Promise.all(toolUses.map(runClientTool));
      history.push({ role: "user", content: results });
      persistHistory();
      render();
    }
  } catch (err) {
    addNotice(errorText(err), "warn", true);
  } finally {
    busy = false;
    currentStream = null;
    live = null;
    setStatus("");
    syncComposer();
    render();
  }
}

function errorText(err) {
  const detail = (err && err.error && err.error.error && err.error.error.message) || (err && err.message) || String(err);
  if (err instanceof Anthropic.AuthenticationError) return "APIキーが正しくありません。設定でキーを確認してください。";
  if (err instanceof Anthropic.PermissionDeniedError) return "このAPIキーでは、選んだモデルやツールを使う権限がありません。";
  if (err instanceof Anthropic.NotFoundError) return "モデルが見つかりません。設定で別のモデルを選んでください。";
  if (err instanceof Anthropic.RateLimitError) return "利用の上限に達しました。少し待つか、Consoleで上限と残高を確認してください。";
  if (err instanceof Anthropic.BadRequestError) return `リクエストが受け付けられませんでした：${detail}`;
  if (err instanceof Anthropic.APIConnectionError) return "通信できませんでした。電波の状態を確認して、もう一度送ってください。";
  if (err instanceof Anthropic.InternalServerError) return "Anthropic側で一時的なエラーが起きました。少し待ってから送り直してください。";
  if (err instanceof Anthropic.APIError) return `エラー（${err.status}）：${detail}`;
  return `予期しないエラー：${detail}`;
}

// ── 表示 ─────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
function inline(s) {
  return s.split(/(`[^`]+`)/).map((part) => {
    if (/^`[^`]+`$/.test(part)) return `<code>${esc(part.slice(1, -1))}</code>`;
    let t = esc(part);
    t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, text, url) => `<a href="${url}" target="_blank" rel="noopener">${text}</a>`);
    t = t.replace(/(^|[\s(（])(https?:\/\/[^\s<)）]+)/g, (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
    return t;
  }).join("");
}
function markdown(src) {
  let html = "", list = null, code = null;
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const line of src.replace(/\r/g, "").split("\n")) {
    if (/^\s*```/.test(line)) {
      if (code) { html += `<pre><code>${esc(code.join("\n"))}</code></pre>`; code = null; }
      else { closeList(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    let m;
    if ((m = /^#{1,6}\s+(.*)/.exec(line))) { closeList(); html += `<h4>${inline(m[1])}</h4>`; continue; }
    if ((m = /^\s*[-*・]\s+(.*)/.exec(line))) {
      if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)/.exec(line))) {
      if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
      html += `<li>${inline(m[1])}</li>`; continue;
    }
    closeList();
    if (line.trim()) html += `<p>${inline(line)}</p>`;
  }
  if (code) html += `<pre><code>${esc(code.join("\n"))}</code></pre>`;
  closeList();
  return html;
}
function host(url) { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return url; } }
function clip(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + "…" : s; }

// 履歴を「ユーザー発言」と「アシスタントのまとまり」に並べ直す
function buildItems() {
  const items = [];
  const assistant = () => {
    let last = items[items.length - 1];
    if (!last || last.kind !== "assistant") { last = { kind: "assistant", blocks: [], results: new Map() }; items.push(last); }
    return last;
  };
  for (const msg of history) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") { items.push({ kind: "user", text: msg.content }); continue; }
      const text = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      for (const b of msg.content) if (b.type === "tool_result") assistant().results.set(b.tool_use_id, b);
      if (text) items.push({ kind: "user", text });
    } else {
      assistant().blocks.push(...msg.content);
    }
  }
  if (live) assistant().blocks.push(...(live.content || []));
  else if (busy) assistant();
  return items;
}

function chip(kind, label, detail, state) {
  const el = document.createElement("div");
  el.className = `chip ${kind}${state ? " " + state : ""}`;
  const l = document.createElement("span");
  l.className = "chip-label";
  l.textContent = label;
  el.append(l);
  if (detail) {
    const d = document.createElement("span");
    d.className = "chip-detail";
    d.textContent = detail;
    el.append(d);
  }
  return el;
}

function renderAssistant(item, isTail) {
  const wrap = document.createElement("article");
  wrap.className = "turn assistant";
  const cited = new Map();
  const found = new Map();
  const doneServer = new Set(item.blocks.filter((b) => /_tool_result$/.test(b.type)).map((b) => b.tool_use_id));
  let text = "";
  const flush = () => {
    if (!text.trim()) { text = ""; return; }
    const div = document.createElement("div");
    div.className = "md";
    div.innerHTML = markdown(text);
    wrap.append(div);
    text = "";
  };

  for (const b of item.blocks) {
    if (b.type === "text") {
      text += b.text;
      for (const c of b.citations || []) if (c.url) cited.set(c.url, c.title || host(c.url));
      continue;
    }
    if (b.type === "thinking" || b.type === "redacted_thinking") continue;
    flush();
    if (b.type === "server_tool_use") {
      const running = !doneServer.has(b.id);
      if (b.name === "web_search") wrap.append(chip("search", "Web検索", b.input && b.input.query, running && "running"));
      else if (b.name === "web_fetch") wrap.append(chip("fetch", "ページを読む", b.input && b.input.url && host(b.input.url), running && "running"));
      else wrap.append(chip("server", "データを整理", "", running && "running"));
    } else if (b.type === "web_search_tool_result") {
      if (Array.isArray(b.content)) {
        for (const r of b.content) if (r.url && !found.has(r.url)) found.set(r.url, r.title || host(r.url));
      } else {
        wrap.append(chip("search", "Web検索", `失敗しました（${(b.content && b.content.error_code) || "不明"}）`, "error"));
      }
    } else if (b.type === "web_fetch_tool_result") {
      if (b.content && b.content.type === "web_fetch_tool_result_error") {
        wrap.append(chip("fetch", "ページを読む", `失敗しました（${b.content.error_code || "不明"}）`, "error"));
      } else if (b.content && b.content.url) {
        found.set(b.content.url, (b.content.content && b.content.content.title) || host(b.content.url));
      }
    } else if (b.type === "tool_use") {
      const res = item.results.get(b.id);
      const args = b.input && Object.keys(b.input).length ? Object.values(b.input).map((v) => clip(typeof v === "string" ? v : JSON.stringify(v), 40)).join("、") : "";
      const el = chip("tool", labelFor(b.name), args, !res ? "running" : res.is_error ? "error" : "");
      if (res) {
        const out = document.createElement("span");
        out.className = "chip-result";
        out.textContent = "→ " + clip(typeof res.content === "string" ? res.content : JSON.stringify(res.content), 160);
        el.append(out);
      }
      wrap.append(el);
    } else if (b.type === "fallback") {
      const note = document.createElement("p");
      note.className = "fallback";
      note.textContent = `安全上の判定により、${(b.to && b.to.model) || "別のモデル"} が回答を引き継ぎました。`;
      wrap.append(note);
    }
  }
  flush();

  const sources = cited.size ? cited : found;
  if (sources.size) {
    const det = document.createElement("details");
    det.className = "sources";
    const sum = document.createElement("summary");
    sum.textContent = `${cited.size ? "出典" : "検索で見つかったページ"}（${sources.size}）`;
    det.append(sum);
    const ol = document.createElement("ol");
    for (const [url, title] of [...sources].slice(0, 12)) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = url; a.target = "_blank"; a.rel = "noopener";
      a.textContent = title;
      const h = document.createElement("span");
      h.className = "src-host";
      h.textContent = host(url);
      li.append(a, h);
      ol.append(li);
    }
    det.append(ol);
    wrap.append(det);
  }

  if (isTail && busy) {
    const st = document.createElement("p");
    st.className = "status";
    st.textContent = statusText || "考えています…";
    wrap.append(st);
  }
  return wrap;
}

function renderItem(item, i, all) {
  if (item.kind === "user") {
    const el = document.createElement("article");
    el.className = "turn user";
    const b = document.createElement("div");
    b.className = "bubble";
    b.textContent = item.text;
    el.append(b);
    return el;
  }
  return renderAssistant(item, i === all.length - 1);
}

function nearBottom() {
  const t = els.thread;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}
function afterRender(stick) {
  els.welcome.hidden = history.length > 0 || busy;
  els.notices.replaceChildren(...notices.map((n) => {
    const p = document.createElement("div");
    p.className = `notice ${n.kind}`;
    const span = document.createElement("span");
    span.textContent = n.text;
    p.append(span);
    if (n.retry && !busy && history.length && history[history.length - 1].role === "user") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "retry";
      btn.textContent = "もう一度";
      btn.addEventListener("click", () => { notices = []; render(); runTurn(); });
      p.append(btn);
    }
    return p;
  }));
  if (stick) els.thread.scrollTop = els.thread.scrollHeight;
}
function render() {
  const stick = nearBottom();
  const items = buildItems();
  els.list.replaceChildren(...items.map(renderItem));
  afterRender(stick);
}
let tailQueued = false;
function scheduleTail() {
  if (tailQueued) return;
  tailQueued = true;
  requestAnimationFrame(() => {
    tailQueued = false;
    const stick = nearBottom();
    const items = buildItems();
    if (items.length && els.list.children.length === items.length) {
      els.list.replaceChild(renderItem(items[items.length - 1], items.length - 1, items), els.list.lastElementChild);
    } else {
      els.list.replaceChildren(...items.map(renderItem));
    }
    afterRender(stick);
  });
}
function setStatus(text) { statusText = text; if (busy) scheduleTail(); }
function addNotice(text, kind, retry) { notices.push({ text, kind, retry: !!retry }); render(); }

// ── 入力欄 ───────────────────────────────────────────────────
function syncComposer() {
  els.send.hidden = busy;
  els.stop.hidden = !busy;
  els.send.disabled = !els.input.value.trim();
  els.modelBadge.textContent = MODELS[settings.model].label;
}
function grow() {
  els.input.style.height = "auto";
  els.input.style.height = Math.min(els.input.scrollHeight + 2, 160) + "px";
}
function send(text) {
  if (!apiKey) { openSettings(); els.apiKey.focus(); return; }
  if (busy) return;
  notices = [];
  history.push({ role: "user", content: text });
  persistHistory();
  render();
  els.thread.scrollTop = els.thread.scrollHeight;
  runTurn();
}

els.input.addEventListener("input", () => {
  grow(); syncComposer();
  try { localStorage.setItem("pc-draft", els.input.value); } catch {}
});
const coarse = matchMedia("(pointer: coarse)").matches;
els.input.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229 || coarse) return;
  e.preventDefault();
  els.form.requestSubmit();
});
els.form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || busy) return;
  els.input.value = "";
  try { localStorage.removeItem("pc-draft"); } catch {}
  grow(); syncComposer();
  send(text);
});
els.stop.addEventListener("click", () => {
  stopRequested = true;
  if (currentStream) currentStream.abort();
  setStatus("止めています…");
});
els.newChat.addEventListener("click", () => {
  if (busy) return;
  if (history.length && !confirm("今の会話を消して、新しい会話を始めますか？")) return;
  history = []; notices = [];
  persistHistory(); render();
  els.input.focus();
});
document.querySelectorAll("[data-example]").forEach((btn) => {
  btn.addEventListener("click", () => { els.input.value = btn.textContent; grow(); syncComposer(); els.input.focus(); });
});

// ── 設定画面 ─────────────────────────────────────────────────
function fillSettings() {
  els.apiKey.value = apiKey;
  els.keyState.textContent = apiKey ? `保存済み（…${apiKey.slice(-4)}）` : "未設定";
  els.model.replaceChildren(...Object.entries(MODELS).map(([id, m]) => new Option(m.label, id, false, id === settings.model)));
  els.effort.replaceChildren(...Object.entries(EFFORTS).map(([id, l]) => new Option(l, id, false, id === settings.effort)));
  els.system.value = settings.system;
  const rows = [
    ...serverTools.map((t) => ({ key: t.id, label: t.label, note: t.note, def: t, server: true })),
    ...clientTools.map((t) => ({ key: t.name, label: t.label, note: t.name, def: t })),
  ];
  els.toolList.replaceChildren(...rows.map((r) => {
    const label = document.createElement("label");
    label.className = "tool-row";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.id = `tool-${r.key}`;
    cb.checked = toolOn(r.key, r.def);
    cb.addEventListener("change", () => { settings.tools[r.key] = cb.checked; persistSettings(); });
    const text = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = r.label;
    const note = document.createElement("small");
    note.textContent = r.server ? r.note : `自作ツール · ${r.note}`;
    text.append(name, note);
    label.append(cb, text);
    return label;
  }));
}
function openSettings() { fillSettings(); els.dialog.showModal(); }

els.openSettings.addEventListener("click", openSettings);
els.closeSettings.addEventListener("click", () => els.dialog.close());
els.apiKey.addEventListener("change", () => {
  apiKey = els.apiKey.value.trim();
  if (!store.set("pc-key", apiKey)) addNotice("APIキーをこの端末に保存できませんでした（プライベートブラウズでは保存されません）。", "warn");
  els.keyState.textContent = apiKey ? `保存済み（…${apiKey.slice(-4)}）` : "未設定";
});
els.showKey.addEventListener("click", () => {
  const show = els.apiKey.type === "password";
  els.apiKey.type = show ? "text" : "password";
  els.showKey.textContent = show ? "隠す" : "表示";
});
els.model.addEventListener("change", () => { settings.model = els.model.value; persistSettings(); syncComposer(); });
els.effort.addEventListener("change", () => { settings.effort = els.effort.value; persistSettings(); });
els.system.addEventListener("change", () => { settings.system = els.system.value; persistSettings(); });
els.resetSystem.addEventListener("click", () => { settings.system = DEFAULT_SYSTEM; els.system.value = DEFAULT_SYSTEM; persistSettings(); });
els.clearAll.addEventListener("click", () => {
  if (!confirm("APIキー・設定・会話・メモをこの端末からすべて削除しますか？")) return;
  try { ["pc-key", "pc-settings", "pc-history", "pc-memos", "pc-draft"].forEach((k) => localStorage.removeItem(k)); } catch {}
  location.reload();
});

// ── 起動 ─────────────────────────────────────────────────────
try { const d = localStorage.getItem("pc-draft"); if (d) els.input.value = d; } catch {}
grow();
syncComposer();
render();
els.thread.scrollTop = els.thread.scrollHeight;
if (!apiKey) openSettings();
