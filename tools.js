// ===== ツール =====
// ツールを足すときは ① tools に定義を足す ② runTool に処理を足す の2か所

// ① Claude に渡すツールの一覧
export const tools = [
  // Web検索（Anthropic のサーバー側で実行されるので、処理は書かなくてよい）
  {
    type: "web_search_20260209",  // ツールの種類と版
    name: "web_search",
    max_uses: 5,                  // 1回の質問で検索する最大回数
    user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" }, // 日本向けの結果を優先
  },

  // 自作ツールの例：現在の日時（この iPhone の中で実行される）
  {
    name: "get_current_time",     // Claude が呼ぶときの名前（英数字と _）
    // いつ使うツールかの説明。Claude はこれを読んで使うか決める
    description: "Returns the current date and time in Japan. Use it when the answer depends on today's date or the time.",
    input_schema: { type: "object", properties: {} }, // 受け取る引数の形（今回は引数なし）
  },
];

// ② Claude がツールを使いたいと言ったときに実行する処理
// name = ツール名、input = Claude が決めた引数。戻り値が結果として Claude に渡る
export async function runTool(name, input) {
  if (name === "get_current_time") {
    return new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "full", timeStyle: "short" });
  }
  throw new Error(`Unknown tool: ${name}`); // 知らないツール名はエラーにする
}
