# Pocket Claude

Claude API で動く、iPhone 向けのチャットアプリ（Web アプリ）です。Mac も Xcode もいりません。
Safari で開いて「ホーム画面に追加」すると、アプリのように全画面で使えます。

- **Web検索**：最新の情報を調べてから答え、出典を表示します（Anthropic のサーバー側ツール）
- **ページを読む**：会話に出てきた URL の中身を読みます
- **自作ツール**：`tools.js` に JavaScript の関数を書くと、Claude が必要なときに呼び出します
  （最初から「現在の日時」「電卓」「メモを保存」「メモを見る」が入っています）
- 設定でモデル（Opus 5.5 / Sonnet 5.5 / Haiku 5.5）、考える深さ、ツールのオン/オフ、システムプロンプトを変えられます

## 使い方

1. https://console.anthropic.com/settings/keys で API キーを作る（従量課金。Web検索は1,000回あたり$10の追加料金）
2. 公開したページを iPhone の Safari で開く
3. 最初に出る設定画面に API キーを貼り付けて「完了」
4. 共有ボタン →「ホーム画面に追加」でアプリ化（任意）

API キーはその iPhone のブラウザ（localStorage）にだけ保存され、`api.anthropic.com` 以外には送られません。
ホーム画面に追加したアプリと Safari は保存場所が別なので、ホーム画面から開いたときにもう一度キーを入力してください。

## 公開（GitHub Pages）

公開用リポジトリ **Yoshi2345/pocket-claude**（公開設定）のルートにこのフォルダの中身を置き、
**Settings → Pages → Build and deployment** で **Source: Deploy from a branch / Branch: main / (root)** を選ぶと、
https://yoshi2345.github.io/pocket-claude/ で開けるようになります。APIキーはページに含まれません。

## ツールの書き足し方

`tools.js` の `clientTools` 配列にオブジェクトを1つ追加します。

```js
{
  name: "roll_dice",                 // 英数字と _（Claude が呼ぶ名前）
  label: "サイコロ",                  // 設定画面に出る名前
  description: "Rolls dice and returns the results. Use it when the user asks to roll dice.",
  input_schema: {
    type: "object",
    properties: { count: { type: "integer", description: "How many dice (1-10)" } },
    required: ["count"],
  },
  run: async ({ count }) => {
    const n = Math.min(Math.max(count, 1), 10);
    return Array.from({ length: n }, () => 1 + Math.floor(Math.random() * 6));
  },
},
```

- `description` は「いつ・何のために使うか」を具体的に書くと、Claude が適切に使います
- `run` は文字列かオブジェクトを返します。失敗したときは `throw new Error("理由")`
- ツールはブラウザ内で動くので、ほかのサイトへの `fetch` は相手が CORS を許可している場合だけ成功します

GitHub の Web 画面（iPhone の Safari でも可）でファイルを編集してコミットすれば、数分後に公開ページへ反映されます。

## ファイル

| ファイル | 内容 |
|---|---|
| `index.html` / `style.css` | 画面 |
| `app.js` | API 呼び出し・ツール実行ループ・表示 |
| `tools.js` | ツール定義（ここを編集） |
| `vendor/anthropic-sdk.js` | 公式 TypeScript SDK `@anthropic-ai/sdk` 0.131.0 をブラウザ用に1ファイルにまとめたもの |

SDK を更新するとき：

```sh
npm install @anthropic-ai/sdk@<version> esbuild
echo 'export { default } from "@anthropic-ai/sdk";' > entry.js
npx esbuild entry.js --bundle --format=esm --platform=browser --minify --target=safari15 --outfile=vendor/anthropic-sdk.js
```

## 仕組みのメモ

- `client.beta.messages.stream()` でストリーミングし、`tool_use` が返ってきたら `tools.js` の関数を実行して `tool_result` を返す、を繰り返します（`pause_turn` はそのまま続行）
- Opus / Sonnet では `fallbacks: "default"`（ベータ `server-side-fallback-2026-07-01`）を有効にしており、安全フィルターで断られた場合はサーバー側で推奨モデルが回答を引き継ぎます
- 会話は `cache_control` で自動的にプロンプトキャッシュされます
