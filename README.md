# Pocket Claude

Claude API（Opus 5.5）と Web 検索で答える、1画面だけのチャットです。

https://yoshi2345.github.io/pocket-claude/

| ファイル | 内容 |
|---|---|
| `index.html` | 画面（会話欄と入力欄） |
| `style.css` | 見た目 |
| `app.js` | API とのやりとり |
| `tools.js` | ツール（ここに書き足す） |
| `vendor/anthropic-sdk.js` | 公式 SDK `@anthropic-ai/sdk` 0.131.0 をブラウザ用に1ファイルにしたもの |

API キーは最初に1回入力すると、その端末のブラウザにだけ保存されます。
ツールを足すときは、`tools.js` の `tools` に定義を、`runTool` に処理を書きます。
