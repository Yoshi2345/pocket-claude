import Anthropic from "./vendor/anthropic-sdk.js";
import { tools, runTool } from "./tools.js";

const MODEL = "claude-opus-5-5";
const SYSTEM = "あなたはiPhoneで使われるアシスタントです。日本語で簡潔に答えてください。Markdownの記号は使わず、普通の文章で書いてください。最新の情報が必要なときは web_search で調べてください。";

const log = document.getElementById("log");
const keyForm = document.getElementById("keyForm");
const keyInput = document.getElementById("key");
const chatForm = document.getElementById("chatForm");
const input = document.getElementById("input");
const sendButton = chatForm.querySelector("button");

let apiKey = localStorage.getItem("apiKey") || "";
const messages = []; // API に送る会話の履歴

// APIキーがなければ、入力欄の代わりにキーの入力欄を出す
function askForKey(show) {
  keyForm.hidden = !show;
  chatForm.hidden = show;
}
askForKey(!apiKey);

keyForm.addEventListener("submit", (e) => {
  e.preventDefault();
  apiKey = keyInput.value.trim();
  localStorage.setItem("apiKey", apiKey);
  askForKey(!apiKey);
});

// 会話欄に1つ追加する
function add(className, text) {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text;
  log.append(div);
  log.scrollTop = log.scrollHeight;
  return div;
}

// Claude の返事（途中経過も含む）を文字にする
function toText(message) {
  return message.content.map((b) => {
    if (b.type === "text") return b.text;
    if (b.type === "server_tool_use" && b.name === "web_search" && b.input?.query) return `［検索：${b.input.query}］\n`;
    if (b.type === "tool_use") return `［${b.name}］\n`;
    return "";
  }).join("");
}

// 引用元のリンクを返事の下に付ける
function addSources(div, message) {
  const urls = new Map();
  for (const b of message.content) {
    for (const c of b.citations ?? []) if (c.url) urls.set(c.url, c.title || c.url);
  }
  // 引用が付かなかったときは、検索で見つかったページを最大5件出す
  if (!urls.size) {
    for (const b of message.content) {
      if (b.type !== "web_search_tool_result" || !Array.isArray(b.content)) continue;
      for (const r of b.content) if (r.url && urls.size < 5) urls.set(r.url, r.title || r.url);
    }
  }
  if (!urls.size) return;
  const box = document.createElement("div");
  box.className = "sources";
  for (const [url, title] of urls) {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.textContent = title;
    box.append(a);
  }
  div.append(box);
}

chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  add("user", text);
  messages.push({ role: "user", content: text });
  sendButton.disabled = true;
  try {
    await chat();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      localStorage.removeItem("apiKey");
      askForKey(true);
      add("error", "APIキーが正しくありません。入れ直してください。");
    } else {
      add("error", `エラー：${err.message}`);
    }
  } finally {
    sendButton.disabled = false;
  }
});

// Claude が答え終わるまで「送る → ツールを実行 → 結果を返す」を繰り返す
async function chat() {
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });

  while (true) {
    const div = add("assistant", "…");
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      system: SYSTEM,
      tools,
      messages,
      cache_control: { type: "ephemeral" },
      // 安全上の判定で断られたら、推奨の別モデルが引き継ぐ
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    stream.on("streamEvent", (_event, snapshot) => { div.textContent = toText(snapshot) || "…"; });

    let message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      div.remove();
      throw err;
    }
    div.textContent = toText(message);
    addSources(div, message);

    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (message.stop_reason === "refusal" || (message.stop_reason === "max_tokens" && toolUses.length)) {
      div.textContent += "\n（回答を中断しました）";
      return;
    }
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "pause_turn") continue; // 検索の続き
    if (!toolUses.length) return;                      // 答え終わった

    const results = await Promise.all(toolUses.map(async (b) => {
      try {
        return { type: "tool_result", tool_use_id: b.id, content: await runTool(b.name, b.input) };
      } catch (err) {
        return { type: "tool_result", tool_use_id: b.id, is_error: true, content: String(err.message ?? err) };
      }
    }));
    messages.push({ role: "user", content: results });
  }
}
