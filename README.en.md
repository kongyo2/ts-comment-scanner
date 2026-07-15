# ts-comment-scanner

[![npm version](https://img.shields.io/npm/v/@kongyo2/ts-comment-scanner.svg)](https://www.npmjs.com/package/@kongyo2/ts-comment-scanner)
[![npm downloads](https://img.shields.io/npm/dm/@kongyo2/ts-comment-scanner.svg)](https://www.npmjs.com/package/@kongyo2/ts-comment-scanner)
[![CI](https://github.com/kongyo2/ts-comment-scanner/actions/workflows/ci.yml/badge.svg)](https://github.com/kongyo2/ts-comment-scanner/actions/workflows/ci.yml)
![CodeRabbit Pull Request Reviews](https://img.shields.io/coderabbit/prs/github/kongyo2/ts-comment-scanner?utm_source=oss&utm_medium=github&utm_campaign=kongyo2%2Fts-comment-scanner&labelColor=171717&color=FF570A&link=https%3A%2F%2Fcoderabbit.ai&label=CodeRabbit+Reviews)
[![node](https://img.shields.io/node/v/@kongyo2/ts-comment-scanner.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@kongyo2/ts-comment-scanner.svg)](./LICENSE)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/kongyo2/ts-comment-scanner)

[日本語](./README.md) | **English**

A CLI / library that detects, lists, and summarizes comments in a TypeScript project — and can also remove them safely. It analyzes code through the TypeScript AST, so it never mistakes strings, template literals, regular expressions, or JSX text for comments.

## Features

- Recursively scans `.ts` `.tsx` `.mts` `.cts` (excluding `node_modules` and `.git`)
- Reports line comments (`//`) and block comments (`/* */`) with position information
- Outputs in three formats: text / JSON / **GitHub Actions annotations**
- **Automatically identifies compiler and linter directives** such as `@ts-ignore` and `eslint-disable`, so you can filter them in or out
- **Safe comment removal** (code cleanup): directives and license headers are kept by default
- **Custom ignore patterns** via glob (`--ignore`) and configurable target extensions (`--ext`)
- `--fail-on-comment` for CI (exit code 1 when comments are detected)
- Usable both as a CLI and as a library

## Installation

```bash
npm install @kongyo2/ts-comment-scanner
```

To run without installing:

```bash
npx @kongyo2/ts-comment-scanner src
```

## CLI usage

```
ts-comment-scanner [options] [paths...]

Output:
  --format <fmt>       Output format: text / json / github (default: text)
  --json               Shorthand for --format json

Filtering:
  --ignore <glob>      Exclude files/directories matching the glob (repeatable)
  --ext <list>         Extensions to scan (comma-separated, default: .ts,.tsx,.mts,.cts)
  --skip-directives    Exclude compiler/linter directives from the results
  --only-directives    Report only directives

CI:
  --fail-on-comment    Exit with code 1 if any comment is reported

Removal:
  --remove             Remove reported comments from files (in place)
  --dry-run            With --remove: show what would be removed without changing files
  --remove-directives  With --remove: also remove directive comments
  --remove-legal       With --remove: also remove license/legal comments

Other:
  -h, --help           Show help
  -v, --version        Show version
```

If no paths are given, the current directory is used. A glob without a slash (e.g. `*.test.ts`) matches against file names, while one that contains a slash (e.g. `src/legacy/**`) matches against paths. Files passed explicitly are never subject to `--ignore`.

**Exit codes**: `0` success / `1` comments detected when `--fail-on-comment` is set / `2` argument or runtime error

### Example output

```bash
$ ts-comment-scanner src
src/index.ts:1:1 [line] // entry point
src/scanner.ts:8:3 [block] /* walk the AST */
src/legacy.ts:3:1 [line] [@ts-ignore] // @ts-ignore fix later

3 comments across 3 files
```

JSON output:

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
          "text": "// entry point",
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

Comments identified as directives get a name attached, such as `"directive": "@ts-ignore"`.

### Using it in GitHub Actions

`--format github` emits each comment as a [workflow command](https://docs.github.com/actions/reference/workflow-commands-for-github-actions), so annotations appear on the relevant lines of a PR.

```yaml
- name: Check for stray comments
  run: npx @kongyo2/ts-comment-scanner --format github --skip-directives --fail-on-comment src
```

```
::notice file=src/index.ts,line=1,endLine=1,col=1,endColumn=13,title=line comment::// entry point
```

### Bulk comment removal (code cleanup)

```bash
# First, check what would be removed
ts-comment-scanner --remove --dry-run src

# Actually remove (directives and license headers are kept)
ts-comment-scanner --remove src

# Remove everything, including directives and legal comments
ts-comment-scanner --remove --remove-directives --remove-legal src
```

Removal is driven by the AST's comment ranges, so it never touches strings or code. In addition:

- Directives such as `@ts-expect-error` / `eslint-disable` are **kept by default**, because removing them would break the build or the linter
- Legal comments — `/*! ... */` or those containing `@license` / `@preserve` / `@copyright` — are also **kept by default**
- Whitespace is inserted where removing a block comment would otherwise join tokens together (`a/* x */b` → `a b`)
- Comment-only lines are removed entirely, and trailing comments are removed together with the preceding whitespace
- The result is re-scanned to verify it, and if the outcome is unexpected the file is left unchanged and an error is reported

### Detectable directives (excerpt)

`@ts-ignore` `@ts-expect-error` `@ts-nocheck` `@ts-check` / the `eslint-disable` family, `eslint-env`, `/* global */` / `tslint:` / the `oxlint-disable` family / the `biome-ignore` family / the `deno-lint-ignore` family / `prettier-ignore` / `istanbul ignore`, `c8 ignore`, `v8 ignore`, `node:coverage` / webpack magic comments such as `webpackChunkName:` / `@vite-ignore` / `#__PURE__` / `//# sourceMappingURL=`, `//# sourceURL=` / `@jsx`-family pragmas / `@jest-environment`, `@vitest-environment` / `/// <reference>` / `#region`, `#endregion`

## Using it as a library

```ts
import { scanPaths, scanComments, removeComments, formatText } from "@kongyo2/ts-comment-scanner";

// Scan files / directories together
const results = await scanPaths(["src"], { ignore: ["**/*.test.ts"] });
console.log(formatText(results));

// Scan a source string directly
const comments = scanComments("// hello\nconst x = 1;");

// Remove comments safely
const { code, removed, kept } = removeComments("// note\nconst x = 1;\n");
```

### Main API

| Function | Summary |
| --- | --- |
| `scanComments(source, options?)` | Get an array of comments from a source string (parse TSX with `options.jsx`) |
| `scanFile(file)` | Scan a single file |
| `scanPaths(inputs, options?)` | Recursively scan files / directories (supports `ignore` / `extensions`) |
| `collectFiles(inputs, options?)` | Collect the list of target file paths |
| `removeComments(source, options?)` | Remove comments safely (`removeDirectives` / `removeLegal` / `shouldRemove`) |
| `detectDirective(kind, text)` | Return a normalized name if the comment is a directive |
| `isLegalComment(text)` | Determine whether a comment is a license/legal comment |
| `formatText(results)` / `formatJson(results)` / `formatGitHub(results)` | Format scan results |

Types: `Comment` / `CommentKind` / `FileScanResult` / `ScanOptions` / `CollectOptions` / `RemoveOptions` / `RemoveResult`

## Requirements

Node.js 20 or later

## License

MIT
