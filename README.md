# ts-comment-scanner

TypeScript プロジェクト内のコメントを検出して一覧・集計する CLI / ライブラリです。TypeScript の AST を使って解析するため、文字列やコードの一部を誤検出しません。

## 特徴

- `.ts` `.tsx` `.mts` `.cts` を再帰的にスキャン（`node_modules` と `.git` は除外）
- 行コメント (`//`) とブロックコメント (`/* */`) を位置情報つきで報告
- テキスト形式と JSON 形式の出力に対応
- CLI としても、ライブラリとしても利用可能

## インストール

```bash
npm install @kongyo2/ts-comment-scanner
```

インストールせずに実行する場合:

```bash
npx @kongyo2/ts-comment-scanner src
```

## CLI の使い方

```
ts-comment-scanner [options] [paths...]

Options:
  --json         結果を JSON で出力
  -v, --version  バージョンを表示
  -h, --help     ヘルプを表示
```

パスを省略するとカレントディレクトリを対象にします。

### 出力例

```bash
$ ts-comment-scanner src
src/index.ts:1:1 [line] // エントリーポイント
src/scanner.ts:8:3 [block] /* AST を走査する */

2 comments across 2 files
```

JSON 出力:

```bash
$ ts-comment-scanner --json src
{
  "summary": { "files": 1, "comments": 1 },
  "files": [
    {
      "file": "src/index.ts",
      "comments": [
        { "kind": "line", "text": "// エントリーポイント", "start": 0, "end": 12, "line": 1, "column": 1 }
      ]
    }
  ]
}
```

## ライブラリとして使う

```ts
import { scanPaths, scanComments, formatText } from "@kongyo2/ts-comment-scanner";

// ファイル / ディレクトリをまとめてスキャン
const results = await scanPaths(["src"]);
console.log(formatText(results));

// ソース文字列を直接スキャン
const comments = scanComments("// hello\nconst x = 1;");
```

### 主な API

| 関数 | 概要 |
| --- | --- |
| `scanComments(source, options?)` | ソース文字列からコメント配列を取得（`options.jsx` で TSX を解析） |
| `scanFile(file)` | 1 ファイルをスキャン |
| `scanPaths(inputs, options?)` | ファイル / ディレクトリ群を再帰的にスキャン |
| `collectFiles(inputs, options?)` | 対象ファイルのパス一覧を収集 |
| `formatText(results)` / `formatJson(results)` | スキャン結果を整形 |

型: `Comment` / `CommentKind` / `FileScanResult` / `ScanOptions` / `CollectOptions`

## 必要環境

Node.js 20 以上

## ライセンス

MIT
