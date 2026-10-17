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

// 裏側の動き（ツール登録・呼び出し・結果など）を小さな文字で出す
function trace(text) {
  return add("trace", text);
}
function short(value, max = 300) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// 返ってきたブロック1つ分を、種類ごとに記録する
function traceBlock(b) {
  if (b.type === "thinking" || b.type === "redacted_thinking") trace("… 思考（内容は非表示）");
  else if (b.type === "server_tool_use") trace(`▶ ${b.name}（サーバー）を呼び出し　入力: ${short(b.input)}`);
  else if (b.type === "tool_use") trace(`▶ ${b.name}（自作）を呼び出し　入力: ${short(b.input)}`);
  else if (b.type === "web_search_tool_result") {
    if (Array.isArray(b.content)) {
      trace(`◀ web_search の結果 ${b.content.length}件\n` + b.content.map((r) => `・${r.title}`).join("\n"));
    } else {
      trace(`◀ web_search 失敗: ${b.content?.error_code}`);
    }
  } else if (b.type === "fallback") trace(`⇄ ${b.from?.model} → ${b.to?.model} に引き継ぎ`);
  else if (b.type !== "text") trace(`◀ ${b.type}: ${short(b.content ?? "", 200)}`);
}

// 引用元のリンクを出す
function addSources(message) {
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
  log.append(box);
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

  for (let round = 1; ; round++) {
    trace(`→ API に送信（${round}回目、メッセージ${messages.length}件）`);
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

    // 本文は届いたそばから表示し、ツールなどのブロックは届き終わったら記録する
    let bubble = null;
    stream.on("text", (delta) => {
      if (!bubble) bubble = add("assistant", "");
      bubble.textContent += delta;
      log.scrollTop = log.scrollHeight;
    });
    stream.on("contentBlock", (block) => {
      if (block.type === "text") return;
      traceBlock(block);
      bubble = null; // このあとの本文は新しい吹き出しに出す
    });

    const message = await stream.finalMessage();
    const u = message.usage;
    trace(`← 受信 stop_reason: ${message.stop_reason}　トークン 入力${u.input_tokens}（キャッシュ${u.cache_read_input_tokens ?? 0}）/ 出力${u.output_tokens}`);
    addSources(message);

    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (message.stop_reason === "refusal" || (message.stop_reason === "max_tokens" && toolUses.length)) {
      add("error", "回答を中断しました。");
      return;
    }
    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "pause_turn") continue; // 検索の続き
    if (!toolUses.length) return;                      // 答え終わった

    const results = await Promise.all(toolUses.map(async (b) => {
      try {
        const content = await runTool(b.name, b.input);
        trace(`◀ ${b.name} の結果: ${short(content)}`);
        return { type: "tool_result", tool_use_id: b.id, content };
      } catch (err) {
        trace(`◀ ${b.name} でエラー: ${err.message ?? err}`);
        return { type: "tool_result", tool_use_id: b.id, is_error: true, content: String(err.message ?? err) };
      }
    }));
    messages.push({ role: "user", content: results });
  }
}

// 起動したときに、使うモデルと登録したツールを表示する
trace(`● 起動　モデル: ${MODEL}`);
for (const t of tools) {
  if (t.type) trace(`● ツール登録 ${t.name}（サーバー: ${t.type}）`);
  else trace(`● ツール登録 ${t.name}（自作）\n　説明: ${t.description}\n　引数: ${short(t.input_schema.properties)}`);
}
