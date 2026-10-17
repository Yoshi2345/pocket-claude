// ─────────────────────────────────────────────────────────────
//  Pocket Claude のツール置き場
//
//  ここに書いたツールが、設定画面に「オン/オフできるツール」として並びます。
//  GitHub の Web 画面（iPhone の Safari でも可）でこのファイルを編集して保存すれば、
//  数分後にアプリへ反映されます。
//
//  ■ サーバーツール（serverTools）
//    Anthropic のサーバー側で動くツール。Web検索・ページ取得はここ。
//    APIキーだけで使えます（Web検索は1,000回あたり$10の追加料金）。
//
//  ■ 自作ツール（clientTools）
//    iPhone のブラウザ内で動く JavaScript の関数。
//      name         … 英数字と _ の名前（Claude が呼ぶときの名前）
//      label        … 設定画面に出す日本語名
//      description  … いつ・何のために使うツールか。Claude はこれを読んで使うか判断します
//      input_schema … 受け取る引数の形（JSON Schema）
//      run(input)   … 実際の処理。文字列かオブジェクトを返す。失敗時は throw する
//    ※ ブラウザ内で動くので、ほかのサイトへの fetch は相手が許可していないと失敗します。
// ─────────────────────────────────────────────────────────────

export const serverTools = [
  {
    id: "web_search",
    label: "Web検索",
    note: "最新の情報をネットで調べます",
    enabled: true,
    // modern = 新しいツール版に対応したモデル（Opus / Sonnet）かどうか
    build: (modern) => ({
      type: modern ? "web_search_20260209" : "web_search_20250305",
      name: "web_search",
      max_uses: 5,
      user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" },
    }),
  },
  {
    id: "web_fetch",
    label: "ページを読む",
    note: "会話に出てきたURLの中身を読みます",
    enabled: true,
    build: (modern) => ({
      type: modern ? "web_fetch_20260209" : "web_fetch_20250910",
      name: "web_fetch",
      max_uses: 5,
    }),
  },
];

const MEMO_KEY = "pc-memos";
function loadMemos() {
  try { return JSON.parse(localStorage.getItem(MEMO_KEY) || "[]"); } catch { return []; }
}
function saveMemos(memos) {
  try { localStorage.setItem(MEMO_KEY, JSON.stringify(memos)); }
  catch { throw new Error("メモを保存できませんでした（ブラウザの保存領域が使えません）"); }
}

export const clientTools = [
  {
    name: "get_current_time",
    label: "現在の日時",
    description: "Returns the current date, time and weekday. Use it whenever the answer depends on today's date or the current time.",
    input_schema: {
      type: "object",
      properties: {
        timezone: { type: "string", description: "IANA time zone, e.g. Asia/Tokyo. Defaults to the device's zone." },
      },
      required: [],
    },
    enabled: true,
    run: async ({ timezone }) => {
      const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
      const now = new Date();
      const text = new Intl.DateTimeFormat("ja-JP", {
        timeZone: tz, dateStyle: "full", timeStyle: "medium",
      }).format(now);
      return { timezone: tz, local: text, iso: now.toISOString() };
    },
  },
  {
    name: "calculate",
    label: "電卓",
    description: "Evaluates an arithmetic expression exactly as written, with + - * / % ^ and parentheses. Use it for any calculation instead of doing math in your head.",
    input_schema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "For example: (1200 * 1.1) / 3" },
      },
      required: ["expression"],
    },
    enabled: true,
    run: async ({ expression }) => ({ expression, result: evaluate(expression) }),
  },
  {
    name: "save_memo",
    label: "メモを保存",
    description: "Saves a short note on this iPhone so it can be read back later with list_memos. Use it when the user asks you to remember or note something.",
    input_schema: {
      type: "object",
      properties: {
        text: { type: "string", description: "The note to save." },
      },
      required: ["text"],
    },
    enabled: true,
    run: async ({ text }) => {
      const memos = loadMemos();
      memos.push({ text: String(text).slice(0, 2000), savedAt: new Date().toISOString() });
      saveMemos(memos.slice(-200));
      return `保存しました（全${Math.min(memos.length, 200)}件）`;
    },
  },
  {
    name: "list_memos",
    label: "メモを見る",
    description: "Returns the notes previously saved with save_memo, oldest first.",
    input_schema: { type: "object", properties: {}, required: [] },
    enabled: true,
    run: async () => {
      const memos = loadMemos();
      return memos.length ? memos : "保存されたメモはありません";
    },
  },
];

// ── 電卓用の小さな式パーサー（eval を使わない） ──
function evaluate(src) {
  const s = String(src)
    .replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[×＊]/g, "*").replace(/[÷／]/g, "/")
    .replace(/[（]/g, "(").replace(/[）]/g, ")")
    .replace(/(\d)[,，](?=\d{3}(?!\d))/g, "$1"); // 1,200 → 1200
  let i = 0;
  const peek = () => s[i];
  const skip = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  function num() {
    skip();
    const m = /^(\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i.exec(s.slice(i));
    if (!m) throw new Error(`式を読めませんでした（${i + 1}文字目付近）`);
    i += m[0].length;
    return parseFloat(m[0]);
  }
  function factor() {
    skip();
    if (peek() === "-") { i++; return -factor(); }
    if (peek() === "+") { i++; return factor(); }
    let v;
    if (peek() === "(") {
      i++; v = expr(); skip();
      if (peek() !== ")") throw new Error("かっこが閉じていません");
      i++;
    } else v = num();
    skip();
    if (peek() === "^") { i++; v = Math.pow(v, factor()); }
    return v;
  }
  function term() {
    let v = factor();
    for (;;) {
      skip();
      const c = peek();
      if (c === "*") { i++; v *= factor(); }
      else if (c === "/") { i++; const d = factor(); if (d === 0) throw new Error("0で割ることはできません"); v /= d; }
      else if (c === "%") { i++; v %= factor(); }
      else return v;
    }
  }
  function expr() {
    let v = term();
    for (;;) {
      skip();
      const c = peek();
      if (c === "+") { i++; v += term(); }
      else if (c === "-") { i++; v -= term(); }
      else return v;
    }
  }
  const v = expr();
  skip();
  if (i < s.length) throw new Error(`使えない文字があります: 「${s[i]}」`);
  if (!Number.isFinite(v)) throw new Error("結果が大きすぎるか、計算できません");
  return Math.round(v * 1e12) / 1e12;
}
