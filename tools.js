// Claude に渡すツールの一覧
export const tools = [
  // Web検索（Anthropic のサーバー側で実行される）
  {
    type: "web_search_20260209",
    name: "web_search",
    max_uses: 5,
    user_location: { type: "approximate", country: "JP", timezone: "Asia/Tokyo" },
  },

  // 自作ツールの例：現在の日時（この iPhone の中で実行される）
  {
    name: "get_current_time",
    description: "Returns the current date and time in Japan. Use it when the answer depends on today's date or the time.",
    input_schema: { type: "object", properties: {} },
  },
];

// Claude がツールを使いたいと言ったときに実行する処理
export async function runTool(name, input) {
  if (name === "get_current_time") {
    return new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "full", timeStyle: "short" });
  }
  throw new Error(`Unknown tool: ${name}`);
}
