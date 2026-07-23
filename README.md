<p align="center">
  <a href="https://kongyo2.github.io/ts-comment-scanner/"><img src="https://raw.githubusercontent.com/kongyo2/ts-comment-scanner/main/assets/logo.svg" width="96" height="96" alt="ts-comment-scanner ロゴ"></a>
</p>

# ts-comment-scanner

[![npm version](https://img.shields.io/npm/v/@kongyo2/ts-comment-scanner.svg)](https://www.npmjs.com/package/@kongyo2/ts-comment-scanner)
[![npm downloads](https://img.shields.io/npm/dm/@kongyo2/ts-comment-scanner.svg)](https://www.npmjs.com/package/@kongyo2/ts-comment-scanner)
[![CI](https://github.com/kongyo2/ts-comment-scanner/actions/workflows/ci.yml/badge.svg)](https://github.com/kongyo2/ts-comment-scanner/actions/workflows/ci.yml)
[![coverage](https://img.shields.io/badge/coverage-100%25-3178C6)](https://kongyo2.github.io/ts-comment-scanner/)
![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/kongyo2/ts-comment-scanner?utm_source=oss&utm_medium=github&utm_campaign=kongyo2%2Fts-comment-scanner&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)
[![node](https://img.shields.io/node/v/@kongyo2/ts-comment-scanner.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@kongyo2/ts-comment-scanner.svg)](./LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/kongyo2/ts-comment-scanner)

**日本語** | [English](./README.en.md) | 📘 [プロジェクトサイト](https://kongyo2.github.io/ts-comment-scanner/)

TypeScript プロジェクト内のコメントを検出・一覧・集計し、安全に削除もできる CLI / ライブラリです。TypeScript の AST を使って解析するため、文字列・テンプレートリテラル・正規表現・JSX テキストを誤検出しません。

## 特徴

- `.ts` `.tsx` `.mts` `.cts` を再帰的にスキャン(`node_modules` と `.git` は除外)。シンボリックリンクは明示指定時と同様に走査中も追跡し、循環は自動検知して停止
- 行コメント (`//`) とブロックコメント (`/* */`) を位置情報つきで報告
- テキスト / JSON / **GitHub Actions アノテーション**の 3 形式で出力
- `@ts-ignore` や `eslint-disable` などの**コンパイラ・リンター指示子(ディレクティブ)を自動判別**し、絞り込み・除外が可能
- **安全なコメント削除**(コードクリーンアップ): ディレクティブとライセンスヘッダーはデフォルトで保持
- UTF-8(BOM 付き可)と BOM 付き UTF-16(LE/BE)に対応。削除時もエンコーディングと BOM を保持し、不正なエンコーディングのファイルは**変更せずに**エラー報告
- Glob による**カスタム無視パターン** (`--ignore`)、対象拡張子の変更 (`--ext`)
- **git 連携 (`--diff`)**: 特定コミット間や未コミットの変更で触れられたファイルだけに対象を絞り込み
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
  --diff <range>       git で変更されたファイルのみを対象(例: HEAD, main..HEAD)
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
::notice file=src/index.ts,line=1,endLine=1,col=1,endColumn=12,title=line comment::// エントリーポイント
```

JSON 出力の `endColumn` が排他的(コメント末尾の次の桁)なのに対し、GitHub アノテーションの列は両端含みのため、ここでは最後の文字の桁(この例では 12)が出力されます。64 KiB を超える巨大なコメントは、GitHub の上限に収まるよう安全に切り詰められます。

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
- `/*! ... */` や `@license` / `@preserve` / `@copyright`、`SPDX-License-Identifier:` / `SPDX-FileCopyrightText:` タグを含む法的コメントも**デフォルトで保持**
- `@ts-expect-error` や `eslint-disable-next-line` など**次行を対象にする指示子の直下の行構造を保持**: 削除すると行が消えて指示子の適用先がずれる場合(コメントだけの行など)、その行のコメントは削除せずに保持
- **位置依存ディレクティブを削除で有効化しない**: prettier の `@format`/`@prettier` pragma(ファイル最初のコメントでのみ有効)や Bun の `// @bun`(ファイル先頭でのみ有効)が、手前のコメント削除によって保持コメント内で新たに効き始める場合は、その手前のコメントも保持
- ブロックコメント除去でトークンが結合してしまう位置には空白を挿入(`a/* x */b` → `a b`)
- コメントだけの行は行ごと削除、行末コメントは手前の空白ごと削除
- 削除後のソースを再スキャンし、残ったコメントが保持対象とディレクティブの意味ごと一致することを検証。想定外の結果になる場合はファイルを変更せずエラー報告
- 書き込みは一時ファイル経由のアトミック置換(書き込み失敗やディスクフルで元ファイルが壊れない)

`--remove --json` の `summary.files` は `files` 配列の件数(削除・保持・スキップのいずれかがあったファイル数)、`summary.changedFiles` は実際にコメントを削除したファイル数です。

### 変更されたファイルだけを対象にする(`--diff`)

`--diff <range>` を付けると、git が変更ありと報告するファイルだけにスキャン・削除を絞り込めます。範囲は `git diff` がリビジョンとして受け付ける書式そのままで、単一リビジョンなら作業ツリーとの比較(未追跡の新規ファイルも含む・`.gitignore` は尊重)、`a..b` / `a...b` ならコミット同士の比較になります。

```bash
# 未コミットの変更があるファイルだけをスキャン
ts-comment-scanner --diff HEAD

# ブランチで変更されたファイルだけからコメントを削除
ts-comment-scanner --remove --diff main...HEAD

# 特定コミット間で変更されたファイルのみを CI でチェック
ts-comment-scanner --fail-on-comment --diff a1b2c3..d4e5f6 src
```

コーディングエージェントに作業させた後、その変更範囲だけを対象にノイズコメントを掃除する、といった使い方を想定しています。範囲内で削除されたファイルは対象外になり、リネームは新しいパスで扱われます。git は最初の入力パスが属するリポジトリで実行されるため、別リポジトリのパスを指定しても動作します。なお `--ignore` と異なり、明示的に指定したファイルにも絞り込みが適用されます。

### 検出できるディレクティブ(抜粋)

各ディレクティブは実ツールのパーサー実装(正規表現・文字列比較)に合わせて判定されます。

- **コンパイラ / 型**: `@ts-ignore` `@ts-expect-error` `@ts-nocheck` `@ts-check` / `/// <reference>` / `@ts-strict-ignore`・`@ts-strict`(typescript-strict-plugin) / `@deno-types=`・`@ts-types=`・`@ts-self-types=`(Deno)
- **リンター**: `eslint-disable` 系・`eslint-env`・`/* global */`・`/* exported */` / `oxlint-disable` 系 / `biome-ignore` 系・`rome-ignore` / `deno-lint-ignore` 系 / `@flow`・`@noflow`・`$FlowFixMe` 系・`flowlint` 系(Flow) / `tslint:`・`jshint`・`jscs:`・`jslint`(レガシー)
- **フォーマッタ**: `prettier-ignore`・`@format`/`@prettier`/`@noformat`/`@noprettier` pragma / `oxfmt-ignore` / `dprint-ignore`・`dprint-ignore-file` / `organize-imports-ignore` / `beautify ignore/preserve`(レガシー)
- **カバレッジ / テスト**: `istanbul ignore`・`c8 ignore`・`v8 ignore`・`node:coverage` / `@jest-environment(-options)`・`@vitest-environment(-options)`・`@module-tag`(Vitest 4) / `Stryker disable/restore` / `type-coverage:ignore-line/-next-line` / `ts-prune-ignore-next`
- **バンドラ / ランタイム**: `webpackChunkName:` などの webpack・turbopack マジックコメント / `@vite-ignore` / `#__PURE__`・`@__NO_SIDE_EFFECTS__`・`@__INLINE__`・`@__KEY__`・`@__MANGLE_PROP__`(terser/rollup 注釈) / `// @bun`(Bun) / `@refresh reset/skip/reload`(react-refresh / solid-refresh) / `million-ignore` / `nx-ignore-next-line`(Nx) / `@unocss-include/-ignore/-skip-start/-skip-end` / `@next-codemod-error/-ignore`(Next.js) / `/* GraphQL */`・`/* HTML */` タグコメント / `//# sourceMappingURL=`・`//# sourceURL=` / `@jsx` 系プラグマ
- **セキュリティ / 静的解析**: `NOSONAR`(SonarQube) / `nosemgrep`(Semgrep) / `lgtm[...]`・`codeql[...]`(CodeQL) / `skipcq`(DeepSource) / `deepcode ignore`(Snyk Code) / `no-dd-sa`・`datadog-disable`(Datadog) / `gitleaks:allow` / `trufflehog:ignore` / `pragma: allowlist secret`(detect-secrets)
- **スペルチェック**: `cspell:` 系(`cSpell:`・`spell-checker:`・`spellchecker:` 別名込み)・`LocalWords` / `codespell:ignore`
- **エディタ / IDE**: `#region`・`#endregion` / `noinspection`・`<editor-fold>`・`language=`(JetBrains) / `ReSharper disable/restore`

## ライブラリとして使う

```ts
import { scanPaths, scanComments, removeComments, changedFiles, formatText } from "@kongyo2/ts-comment-scanner";

// ファイル / ディレクトリをまとめてスキャン
const results = await scanPaths(["src"], { ignore: ["**/*.test.ts"] });
console.log(formatText(results));

// ソース文字列を直接スキャン
const comments = scanComments("// hello\nconst x = 1;");

// コメントを安全に削除
const { code, removed, kept } = removeComments("// note\nconst x = 1;\n");

// git のリビジョン範囲で変更されたファイルの絶対パスを取得
const changed = await changedFiles("main..HEAD");
```

### 主な API

| 関数 | 概要 |
| --- | --- |
| `scanComments(source, options?)` | ソース文字列からコメント配列を取得(`options.jsx` で TSX を解析) |
| `scanFile(file)` | 1 ファイルをスキャン |
| `scanPaths(inputs, options?)` | ファイル / ディレクトリ群を再帰的にスキャン(`ignore` / `extensions` 対応) |
| `collectFiles(inputs, options?)` | 対象ファイルのパス一覧を収集 |
| `changedFiles(range, cwd?)` | git のリビジョン範囲で変更された作業ツリーのファイルを絶対パスで返す |
| `removeComments(source, options?)` | コメントを安全に削除(`removeDirectives` / `removeLegal` / `shouldRemove`) |
| `detectDirective(kind, text, placement?)` | コメントがディレクティブなら正規化した名前を返す(`placement` で位置依存の判定が可能) |
| `isLegalComment(text)` | ライセンス・法的コメントかどうかを判定 |
| `formatText(results)` / `formatJson(results)` / `formatGitHub(results)` | スキャン結果を整形 |
| `readFileText(file)` / `decodeFileText(data)` / `encodeFileText(text, target)` | UTF-8 / UTF-16 と BOM を保持するファイル読み書きヘルパー |
| `writeFileAtomic(file, data)` | 一時ファイル経由でファイルをアトミックに置換 |

型: `Comment` / `CommentKind` / `FileScanResult` / `ScanOptions` / `CollectOptions` / `RemoveOptions` / `RemoveResult` / `FileText` / `FileEncoding` / `DirectivePlacement`

## 必要環境

Node.js 20 以上

## ライセンス

MIT
