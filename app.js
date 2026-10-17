// ===== アプリの本体 =====
// 流れ: 送信 → chat() が API に送る → ツールを使うなら runTool() で実行して結果を返す → 答えを表示

import Anthropic from "./vendor/anthropic-sdk.js"; // 公式 SDK（API を呼ぶ道具）
import { tools, runTool } from "./tools.js";       // ツールの定義と処理

const MODEL = "claude-opus-5-5"; // 使うモデル
// SYSTEM = Claude への基本の指示（システムプロンプト）
const SYSTEM = "あなたはiPhoneで使われるアシスタントです。日本語で簡潔に答えてください。Markdownの記号は使わず、普通の文章で書いてください。最新の情報が必要なときは web_search で調べてください。";

// 画面の部品（index.html の id と対応）
const log = document.getElementById("log");               // 会話欄
const keyForm = document.getElementById("keyForm");       // APIキーの入力欄
const keyInput = document.getElementById("key");
const chatForm = document.getElementById("chatForm");     // メッセージの入力欄
const input = document.getElementById("input");
const sendButton = chatForm.querySelector("button");

let apiKey = localStorage.getItem("apiKey") || ""; // 端末に保存したキーを読む
const messages = []; // API に送る会話の履歴（毎回これを丸ごと送る）

// APIキーがなければ、入力欄の代わりにキーの入力欄を出す
function askForKey(show) {
  keyForm.hidden = !show;
  chatForm.hidden = show;
}
askForKey(!apiKey);

// キーの「保存」を押したとき：端末に保存してチャット欄に切り替える
keyForm.addEventListener("submit", (e) => {
  e.preventDefault(); // ページの再読み込みを止める
  apiKey = keyInput.value.trim();
  localStorage.setItem("apiKey", apiKey);
  askForKey(!apiKey);
});

// 会話欄に1行（1つの吹き出し）を追加する。className で見た目が変わる
function add(className, text) {
  const div = document.createElement("div");
  div.className = className;
  div.textContent = text; // textContent なので HTML として実行されない（安全）
  log.append(div);
  log.scrollTop = log.scrollHeight; // 一番下までスクロール
  return div;
}

// 裏側の動き（ツール登録・呼び出し・結果など）を小さな灰色の文字で出す
function trace(text) {
  return add("trace", text);
}
// 長い値を max 文字で切って文字列にする（ログ表示用）
function short(value, max = 300) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? text.slice(0, max) + "…" : text;
}

// API から届いたブロック1つ分を、種類（type）ごとにログに出す
function traceBlock(b) {
  if (b.type === "thinking" || b.type === "redacted_thinking") trace("… 思考（内容は非表示）");
  else if (b.type === "server_tool_use") trace(`▶ ${b.name}（サーバー）を呼び出し　入力: ${short(b.input)}`);
  else if (b.type === "tool_use") trace(`▶ ${b.name}（自作）を呼び出し　入力: ${short(b.input)}`);
  else if (b.type === "web_search_tool_result") {
    if (Array.isArray(b.content)) { // 成功なら結果の配列、失敗ならエラーのオブジェクト
      trace(`◀ web_search の結果 ${b.content.length}件\n` + b.content.map((r) => `・${r.title}`).join("\n"));
    } else {
      trace(`◀ web_search 失敗: ${b.content?.error_code}`);
    }
  } else if (b.type === "fallback") trace(`⇄ ${b.from?.model} → ${b.to?.model} に引き継ぎ`);
  else if (b.type !== "text") trace(`◀ ${b.type}: ${short(b.content ?? "", 200)}`); // その他（検索の絞り込み処理など）
}

// 答えの引用元（出典）をリンクで出す
function addSources(message) {
  const urls = new Map(); // URL → タイトル（同じURLは1回だけ）
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
    a.target = "_blank"; // 新しいタブで開く
    a.textContent = title;
    box.append(a);
  }
  log.append(box);
}

// 「送信」を押したとき
chatForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  add("user", text);                             // 自分の吹き出しを出す
  messages.push({ role: "user", content: text }); // 履歴に追加
  sendButton.disabled = true;                     // 返事が来るまで送信できなくする
  try {
    await chat();
  } catch (err) {
    // エラーの種類ごとに処理する
    if (err instanceof Anthropic.AuthenticationError) { // キーが間違っている
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
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true }); // ブラウザから直接 API を呼ぶ

  for (let round = 1; ; round++) {
    trace(`→ API に送信（${round}回目、メッセージ${messages.length}件）`);
    // stream = 答えを少しずつ受け取る送り方
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,                    // 1回の返事の最大の長さ
      system: SYSTEM,
      tools,                                // 使ってよいツールの一覧
      messages,                             // これまでの会話
      cache_control: { type: "ephemeral" }, // 同じ部分をキャッシュして安く・速くする
      // 安全上の判定で断られたら、推奨の別モデルが引き継ぐ
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });

    // 本文は届いたそばから表示し、ツールなどのブロックは届き終わったらログに出す
    let bubble = null; // 今書き込み中の吹き出し
    stream.on("text", (delta) => {             // 本文の続きが届いたとき
      if (!bubble) bubble = add("assistant", "");
      bubble.textContent += delta;
      log.scrollTop = log.scrollHeight;
    });
    stream.on("contentBlock", (block) => {     // ブロックが1つ届き終わったとき
      if (block.type === "text") return;
      traceBlock(block);
      bubble = null; // このあとの本文は新しい吹き出しに出す
    });

    const message = await stream.finalMessage(); // 返事が全部届くまで待つ
    const u = message.usage;                     // 使ったトークン数
    trace(`← 受信 stop_reason: ${message.stop_reason}　トークン 入力${u.input_tokens}（キャッシュ${u.cache_read_input_tokens ?? 0}）/ 出力${u.output_tokens}`);
    addSources(message);

    // stop_reason（止まった理由）で次にやることを決める
    const toolUses = message.content.filter((b) => b.type === "tool_use"); // 自作ツールの呼び出し
    if (message.stop_reason === "refusal" || (message.stop_reason === "max_tokens" && toolUses.length)) {
      add("error", "回答を中断しました。"); // 断られた／長すぎて途中で切れた → 履歴に入れずに終わる
      return;
    }
    messages.push({ role: "assistant", content: message.content }); // Claude の返事を履歴に追加

    if (message.stop_reason === "pause_turn") continue; // 検索の途中で一時停止 → そのまま続きを頼む
    if (!toolUses.length) return;                      // ツールを使わない → 答え終わった

    // 自作ツールを実行して、結果を tool_result として返す（複数あれば同時に実行）
    const results = await Promise.all(toolUses.map(async (b) => {
      try {
        const content = await runTool(b.name, b.input);
        trace(`◀ ${b.name} の結果: ${short(content)}`);
        return { type: "tool_result", tool_use_id: b.id, content };
      } catch (err) {
        // 失敗も is_error 付きで Claude に伝える
        trace(`◀ ${b.name} でエラー: ${err.message ?? err}`);
        return { type: "tool_result", tool_use_id: b.id, is_error: true, content: String(err.message ?? err) };
      }
    }));
    messages.push({ role: "user", content: results }); // 結果を履歴に追加して、もう一周
  }
}

// 起動したときに、使うモデルと登録したツールを表示する
trace(`● 起動　モデル: ${MODEL}`);
for (const t of tools) {
  if (t.type) trace(`● ツール登録 ${t.name}（サーバー: ${t.type}）`); // type があるのはサーバーツール
  else trace(`● ツール登録 ${t.name}（自作）\n　説明: ${t.description}\n　引数: ${short(t.input_schema.properties)}`);
}
