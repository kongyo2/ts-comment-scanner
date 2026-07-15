# ts-comment-scanner

[![npm version](https://img.shields.io/npm/v/@kongyo2/ts-comment-scanner.svg)](https://www.npmjs.com/package/@kongyo2/ts-comment-scanner)
[![npm downloads](https://img.shields.io/npm/dm/@kongyo2/ts-comment-scanner.svg)](https://www.npmjs.com/package/@kongyo2/ts-comment-scanner)
[![CI](https://github.com/kongyo2/ts-comment-scanner/actions/workflows/ci.yml/badge.svg)](https://github.com/kongyo2/ts-comment-scanner/actions/workflows/ci.yml)
![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/kongyo2/ts-comment-scanner?utm_source=oss&utm_medium=github&utm_campaign=kongyo2%2Fts-comment-scanner&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)
[![node](https://img.shields.io/node/v/@kongyo2/ts-comment-scanner.svg)](https://nodejs.org)
[![install size](https://packagephobia.com/badge?p=@kongyo2/ts-comment-scanner)](https://packagephobia.com/result?p=@kongyo2/ts-comment-scanner)
[![license](https://img.shields.io/npm/l/@kongyo2/ts-comment-scanner.svg)](./LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/kongyo2/ts-comment-scanner)

TypeScript プロジェクト内のコメントを検出・一覧・集計し、安全に削除もできる CLI / ライブラリです。TypeScript の AST を使って解析するため、文字列・テンプレートリテラル・正規表現・JSX テキストを誤検出しません。

## 特徴

- `.ts` `.tsx` `.mts` `.cts` を再帰的にスキャン(`node_modules` と `.git` は除外)
- 行コメント (`//`) とブロックコメント (`/* */`) を位置情報つきで報告
- テキスト / JSON / **GitHub Actions アノテーション**の 3 形式で出力
- `@ts-ignore` や `eslint-disable` などの**コンパイラ・リンター指示子(ディレクティブ)を自動判別**し、絞り込み・除外が可能
- **安全なコメント削除**(コードクリーンアップ): ディレクティブとライセンスヘッダーはデフォルトで保持
- Glob による**カスタム無視パターン** (`--ignore`)、対象拡張子の変更 (`--ext`)
- CI 向けの `--fail-on-comment`(コメント検出時に終了コード 1)
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

出力:
  --format <fmt>       出力形式: text / json / github(既定: text)
  --json               --format json の短縮形

フィルタリング:
  --ignore <glob>      Glob に一致するファイル・ディレクトリを除外(複数指定可)
  --ext <list>         スキャン対象の拡張子(カンマ区切り、既定: .ts,.tsx,.mts,.cts)
  --skip-directives    コンパイラ・リンター指示子を結果から除外
  --only-directives    指示子のみを報告

CI:
  --fail-on-comment    コメントが報告された場合に終了コード 1 で終了

削除:
  --remove             報告対象のコメントをファイルから削除(インプレース)
  --dry-run            --remove と併用: 変更せずに削除対象のみ表示
  --remove-directives  --remove と併用: 指示子コメントも削除
  --remove-legal       --remove と併用: ライセンス・法的コメントも削除

その他:
  -h, --help           ヘルプを表示
  -v, --version        バージョンを表示
```

パスを省略するとカレントディレクトリを対象にします。スラッシュを含まない Glob(例: `*.test.ts`)はファイル名に、含むもの(例: `src/legacy/**`)はパスに一致します。明示的に指定したファイルは `--ignore` の対象になりません。

**終了コード**: `0` 成功 / `1` `--fail-on-comment` 指定時にコメントを検出 / `2` 引数・実行時エラー

### 出力例

```bash
$ ts-comment-scanner src
src/index.ts:1:1 [line] // エントリーポイント
src/scanner.ts:8:3 [block] /* AST を走査する */
src/legacy.ts:3:1 [line] [@ts-ignore] // @ts-ignore 後で直す

3 comments across 3 files
```

JSON 出力:

```bash
$ ts-comment-scanner --json src
{
  "summary": { "files": 1, "comments": 1, "directives": 0 },
  "files": [
    {
      "file": "src/index.ts",
      "comments": [
        {
          "kind": "line",
          "text": "// エントリーポイント",
          "start": 0,
          "end": 12,
          "line": 1,
          "column": 1,
          "endLine": 1,
          "endColumn": 13
        }
      ]
    }
  ]
}
```

ディレクティブと判定されたコメントには `"directive": "@ts-ignore"` のように名前が付きます。

### GitHub Actions で使う

`--format github` は各コメントを [workflow command](https://docs.github.com/actions/reference/workflow-commands-for-github-actions) として出力するため、PR の該当行にアノテーションが表示されます。

```yaml
- name: Check for stray comments
  run: npx @kongyo2/ts-comment-scanner --format github --skip-directives --fail-on-comment src
```

```
::notice file=src/index.ts,line=1,endLine=1,col=1,endColumn=13,title=line comment::// エントリーポイント
```

### コメントの一括削除(コードクリーンアップ)

```bash
# まず削除対象を確認
ts-comment-scanner --remove --dry-run src

# 実際に削除(ディレクティブとライセンスヘッダーは保持される)
ts-comment-scanner --remove src

# 指示子・ライセンスも含めて完全に削除
ts-comment-scanner --remove --remove-directives --remove-legal src
```

削除は AST のコメント範囲に基づいて行われるため、文字列やコードには影響しません。さらに:

- `@ts-expect-error` / `eslint-disable` などの指示子は、削除するとビルドやリントが壊れるため**デフォルトで保持**
- `/*! ... */` や `@license` / `@preserve` / `@copyright` を含む法的コメントも**デフォルトで保持**
- ブロックコメント除去でトークンが結合してしまう位置には空白を挿入(`a/* x */b` → `a b`)
- コメントだけの行は行ごと削除、行末コメントは手前の空白ごと削除
- 削除後のソースを再スキャンして検証し、想定外の結果になる場合はファイルを変更せずエラー報告

### 検出できるディレクティブ(抜粋)

`@ts-ignore` `@ts-expect-error` `@ts-nocheck` `@ts-check` / `eslint-disable` 系・`eslint-env`・`/* global */` / `tslint:` / `oxlint-disable` 系 / `biome-ignore` 系 / `deno-lint-ignore` 系 / `prettier-ignore` / `istanbul ignore`・`c8 ignore`・`v8 ignore`・`node:coverage` / `webpackChunkName:` などの webpack マジックコメント / `@vite-ignore` / `#__PURE__` / `//# sourceMappingURL=`・`//# sourceURL=` / `@jsx` 系プラグマ / `@jest-environment`・`@vitest-environment` / `/// <reference>` / `#region`・`#endregion`

## ライブラリとして使う

```ts
import { scanPaths, scanComments, removeComments, formatText } from "@kongyo2/ts-comment-scanner";

// ファイル / ディレクトリをまとめてスキャン
const results = await scanPaths(["src"], { ignore: ["**/*.test.ts"] });
console.log(formatText(results));

// ソース文字列を直接スキャン
const comments = scanComments("// hello\nconst x = 1;");

// コメントを安全に削除
const { code, removed, kept } = removeComments("// note\nconst x = 1;\n");
```

### 主な API

| 関数 | 概要 |
| --- | --- |
| `scanComments(source, options?)` | ソース文字列からコメント配列を取得(`options.jsx` で TSX を解析) |
| `scanFile(file)` | 1 ファイルをスキャン |
| `scanPaths(inputs, options?)` | ファイル / ディレクトリ群を再帰的にスキャン(`ignore` / `extensions` 対応) |
| `collectFiles(inputs, options?)` | 対象ファイルのパス一覧を収集 |
| `removeComments(source, options?)` | コメントを安全に削除(`removeDirectives` / `removeLegal` / `shouldRemove`) |
| `detectDirective(kind, text)` | コメントがディレクティブなら正規化した名前を返す |
| `isLegalComment(text)` | ライセンス・法的コメントかどうかを判定 |
| `formatText(results)` / `formatJson(results)` / `formatGitHub(results)` | スキャン結果を整形 |

型: `Comment` / `CommentKind` / `FileScanResult` / `ScanOptions` / `CollectOptions` / `RemoveOptions` / `RemoveResult`

## 必要環境

Node.js 20 以上

## ライセンス

MIT
