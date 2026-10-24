import { docblockPragmas } from "./docblock.js";
import { lastLine, splitLines } from "./lines.js";
import type { CommentKind } from "./types.js";

interface DirectiveRule {
  pattern: RegExp;
  /**
   * Fixed name, or derive it from the match — returning undefined rejects the
   * match, for checks a single regex cannot express, and a list reports every
   * directive the match carries (a docblock can hold several pragmas).
   * Defaults to the full matched text.
   */
  name?: string | ((match: RegExpExecArray) => string | readonly string[] | undefined);
  blockOnly?: boolean;
  /** Only match line comments (e.g. JetBrains suppressions in JS/TS). */
  lineOnly?: boolean;
  /**
   * Only match comments whose text holds no line feed — `//` comments and
   * single-line block comments, the comments CodeQL reads suppressions from.
   */
  singleLine?: boolean;
  /** Match any content line, not just the first (for docblock pragmas). */
  anyLine?: boolean;
  /**
   * Match the content lines joined into one, for label-plus-options directives
   * whose options may continue on later lines, like a block comment opening
   * with `jshint` and `esversion: 6` below it. The label still has to open
   * the comment.
   */
  joinLines?: boolean;
  /**
   * Match against the raw comment text, markers included, for tools that
   * compare the literal source (bun's `// @bun` prefix, Stryker's
   * `^\s?Stryker` on the comment value, JSLint's no-space-after-marker rule).
   */
  rawText?: boolean;
  /**
   * Skip `/**`-opened block comments: the datadog analyzer skips only
   * whitespace before its marker, so a leading `*` defeats it.
   */
  notDocblock?: boolean;
  /**
   * Match content lines verbatim, without stripping JSDoc `*` prefixes, for
   * tools that compare the literal comment value (prettier/oxfmt compare the
   * trimmed body, so `/** prettier-ignore *​/` is NOT a suppression to them).
   */
  keepStars?: boolean;
}

// stylelint's configuration commands, compared verbatim (as in its
// `configurationComment.mjs`) once the marker has been cut out of the
// comment's first token.
const STYLELINT_MARKER = "stylelint";
const STYLELINT_COMMANDS: ReadonlySet<string> = new Set(["-disable", "-disable-line", "-disable-next-line", "-enable"]);

/**
 * The stylelint command the comment's first whitespace-delimited token
 * carries, if any. Mirrors `isConfigurationComment`: `String#replace` with a
 * string pattern drops only the FIRST `stylelint` in the token, wherever it
 * sits, and the remainder must equal a command exactly (case-sensitively) —
 * so `-disable` alone, or `-disablestylelint`, is a live command to stylelint
 * while `stylelintstylelint-disable` is not.
 */
function stylelintDirective(token: string): string | undefined {
  const command = token.replace(STYLELINT_MARKER, "");
  return STYLELINT_COMMANDS.has(command) ? `${STYLELINT_MARKER}${command}` : undefined;
}

// Prettier's FORMAT_PRAGMAS and FORMAT_IGNORE_PRAGMAS (its
// `src/utilities/pragma/pragma.evaluate.js`): the docblock keys that
// --require-pragma looks for and --check-ignore-pragma stops on.
const FORMAT_PRAGMA_KEYS: ReadonlySet<string> = new Set(["format", "prettier", "noformat", "noprettier"]);

// The canonical spelling of each JSX pragma, keyed by its lowercased name.
const JSX_PRAGMAS: ReadonlyMap<string, string> = new Map(
  ["jsx", "jsxFrag", "jsxRuntime", "jsxImportSource", "jsxImportSourceTypes"].map((name) => [
    name.toLowerCase(),
    `@${name}`,
  ]),
);

// typescript-strict-plugin's two pragmas; the capture is the `-ignore` suffix.
const tsStrictName = (match: RegExpExecArray): string => (match[1] === undefined ? "@ts-strict" : "@ts-strict-ignore");

const RULES: DirectiveRule[] = [
  // ESLint and oxlint. ESLint 10 takes the label from the trimmed comment value
  // (`[a-z]+(?:-[a-z]+)*` followed by whitespace or the end) and honours only
  // `eslint-disable-line`/`-next-line` in `//` comments; oxlint reads all four
  // commands, and its own prefix, from comments of either kind, under the
  // same boundary. A JSDoc star in front of the label defeats both, and so
  // does a glued suffix (`eslint-disable-foo`, `eslint-disable:foo`).
  { pattern: /^(?:eslint|oxlint)-(?:disable(?:-next-line|-line)?|enable)(?=\s|$)/, keepStars: true },
  // ESLint 10 reports `/* eslint-env */` comments as no longer supported, and
  // ESLint 9's eslintrc mode still applies them; both read block comments
  // only, like the configuration comments below.
  { pattern: /^eslint-env(?=\s|$)/, blockOnly: true, keepStars: true },
  { pattern: /^eslint\s+\S/, name: "eslint", blockOnly: true, joinLines: true, keepStars: true },
  {
    pattern: /^(globals?|exported)\s+\S/,
    name: (match) => match[1] as string,
    blockOnly: true,
    joinLines: true,
    keepStars: true,
  },
  // TSLint (legacy): tslint:(enable|disable)(-line|-next-line)? ending at a
  // colon, whitespace or the end of the comment value.
  { pattern: /^tslint:(?:enable|disable)(?:-line|-next-line)?(?=:|\s|$)/, keepStars: true },
  // JSHint (legacy): `key: value` options and ignore markers (`jshint
  // esversion: 6`, `jshint ignore:line`) plus `-W###`/`+W###` warning toggles.
  // Requiring those shapes keeps prose like `jshint is unused` ordinary.
  { pattern: /^jshint\s+(?:[A-Za-z$_][\w$]*\s*:|[-+]W\d+\b)/, name: "jshint", joinLines: true },
  // JSCS (legacy) allows whitespace on both sides of the colon (`jscs :
  // enable`), so the name is normalised to the compact form.
  {
    pattern: /^jscs\s*:\s*(disable|enable|ignore)/,
    name: (match) => `jscs:${match[1]}`,
    joinLines: true,
    keepStars: true,
  },
  // JSLint: the directive word must sit immediately after the comment marker
  // with no space (`/*jslint devel*/` works, `/* jslint */` does not) and
  // needs a body, so these match the raw text; `//global` counts too. The
  // whole-line pragmas (`/*jslint-disable*/`, `//jslint-ignore-line`) are
  // exact strings.
  { pattern: /^\/[/*](jslint|property|global)\s+\S/, rawText: true, name: (match) => match[1] as string },
  { pattern: /^\/\*jslint-(disable|enable)\*\/$/, rawText: true, name: (match) => `jslint-${match[1]}` },
  { pattern: /^\/\/jslint-(ignore-line|quiet)$/, rawText: true, name: (match) => `jslint-${match[1]}` },
  // Biome parses every line of a comment (leading `*`s stripped) that opens
  // with `biome-ignore`; `-all` applies only before the file's first token
  // (anything later is rejected as a misplaced top-level suppression).
  {
    pattern: /^biome-ignore(-all|-start|-end)?/,
    name: (match) => `biome-ignore${match[1] ?? ""}`,
    anyLine: true,
  },
  // Rome (Biome's predecessor) used the same line-by-line parser: a
  // case-insensitive keyword with `-` or `_`, then categories (`lint`,
  // `lint/<group>/<rule>`, `format`, `parse`, ...) and a mandatory colon —
  // without the colon Rome reported a parse diagnostic and the suppression
  // stayed inert.
  {
    pattern:
      /^rome[-_]ignore\s*(?:(?:lint(?:\/[A-Za-z0-9]+){0,2}|parse(?:\/[A-Za-z0-9]+)?|format|organizeImports)(?:\([^)]*\))?\s*)+:/i,
    name: "rome-ignore",
    anyLine: true,
  },
  // Deno. deno_lint compares the first whitespace-delimited token of the
  // trimmed comment text with the directive, so a JSDoc star in front defeats
  // it; `deno-lint-ignore` may be a block comment (the only form inside JSX
  // children), the file form only a line comment in the header. The coverage
  // directives are line comments compared the same way, and
  // `deno-coverage-ignore-file` only counts as the file's first comment.
  { pattern: /^deno-lint-ignore(?=\s|$)/, keepStars: true },
  { pattern: /^deno-(?:lint-ignore-file|coverage-ignore(?:-file|-start|-stop)?)(?=\s|$)/, lineOnly: true },
  // Deno type directives. deno_graph matches them case-insensitively at the
  // start of the comment text; `@deno-types` accepts a bare specifier, the
  // newer names require quotes. A JSDoc star in front defeats them.
  { pattern: /^@deno-types\s*=\s*(?:["'][^"']+["']|\S+)/i, keepStars: true, name: "@deno-types" },
  { pattern: /^@ts-types\s*=\s*["'][^"']+["']/i, keepStars: true, name: "@ts-types" },
  { pattern: /^@ts-self-types\s*=\s*["'][^"']+["']/i, keepStars: true, name: "@ts-self-types" },
  // stylelint. A configuration comment is recognised from the first
  // whitespace-delimited token of the trimmed comment body alone (see
  // stylelintDirective), so a glued rule list, a suffix, prose before the
  // marker or a different case leave the comment inert — as does a JSDoc star
  // after `/**`, which postcss keeps as comment text (hence keepStars). `//`
  // comments count too: postcss-scss and postcss-less hand stylelint the same
  // trimmed text. Verified against stylelint 17.16. A project-specific
  // `configurationComment` prefix cannot be known here, so only the default
  // marker is matched.
  { pattern: /^\S+/, keepStars: true, name: (match) => stylelintDirective(match[0]) },
  // Formatter suppressions (prettier, and oxfmt which mirrors it). Prettier's
  // isPrettierIgnoreComment compares `comment.value.trim()` with the exact
  // string, for line and block comments alike, so the marker must be the
  // whole comment (joinLines makes `$` span every line): hyphenated
  // lookalikes (`oxfmt-ignore-more`) and prose stay ordinary, and so do
  // `prettier-ignore-start`/`-end`, which prettier only reads in Markdown.
  // keepStars, because the literal comparison also means a JSDoc `*` before
  // the marker (`/** prettier-ignore *​/`) leaves the comment ordinary.
  { pattern: /^prettier-ignore$/, joinLines: true, keepStars: true },
  { pattern: /^oxfmt-ignore$/, joinLines: true, keepStars: true },
  // dprint, and `deno fmt`, which runs dprint's TypeScript plugin with
  // `deno-fmt-ignore`/`deno-fmt-ignore-file` as its comment texts. The file
  // pragma is a starts-with check on the file's leading comments, after only
  // spaces in a `//` comment and any whitespace in a block one, so a tab or a
  // `/**` docblock star defeats it. The node pragma is a substring bounded by
  // non-alphanumerics anywhere in the comment, so a reason may follow — and
  // below the header a stray file pragma still counts as one.
  {
    pattern: /^\/(?:\/ *|\*\s*)(dprint|deno-fmt)-ignore-file/,
    rawText: true,
    name: (match) => `${match[1] as string}-ignore-file`,
  },
  {
    pattern: /(?:^|[^\p{L}\p{N}])(dprint|deno-fmt)-ignore(?![\p{L}\p{N}])/u,
    name: (match) => `${match[1] as string}-ignore`,
    anyLine: true,
  },
  // Prettier pragma mode (--require-pragma / --check-ignore-pragma). Prettier
  // reads the pragmas through jest-docblock (its `src/language-js/pragma.js`):
  // only the file's first block comment counts, and a pragma is a key that
  // opens a line of the docblock, so `@prettier-plugin` is a different key and
  // stays ordinary. The port in docblock.ts carries jest-docblock's exact
  // line-shape rules (spaces only before the gutter star and the `@`).
  {
    pattern: /^\/\*/,
    rawText: true,
    blockOnly: true,
    name: (match) =>
      docblockPragmas(match.input)
        .filter((key) => FORMAT_PRAGMA_KEYS.has(key))
        .map((key) => `@${key}`),
  },
  // JSDoc type casts. Prettier's isTypeCastComment takes any `/**` docblock
  // whose value matches /@(?:type|satisfies)\b/ and keeps the parentheses of
  // the expression that follows it (`/** @type {Foo} *​/ (bar)`), the cast
  // tsc itself honours in JavaScript. A `/*` comment or `@typedef` is not one.
  { pattern: /^\/\*\*[^]*?@(type|satisfies)\b/, rawText: true, blockOnly: true, name: (match) => `@${match[1]}` },
  // Import sorting. prettier-plugin-organize-imports skips a file whose text
  // contains `// organize-imports-ignore` or `// tslint:disable:ordered-imports`
  // (single space included, so it matches the raw comment text);
  // @trivago/prettier-plugin-sort-imports, and Bun's port of it, skip one
  // whose leading or import comments start with `sort-imports-ignore` once
  // leading whitespace is trimmed.
  {
    pattern: /\/\/ (?:organize-imports-ignore|tslint:disable:ordered-imports)/,
    rawText: true,
    name: "organize-imports-ignore",
  },
  { pattern: /^sort-imports-ignore/, keepStars: true, name: "sort-imports-ignore" },
  // js-beautify (legacy): exact-shape block comments with single spaces; only
  // the ignore/preserve pairs have an effect. The comment ending an ignored
  // range is searched with `\s` instead, so any one whitespace character
  // separates its words.
  {
    pattern: /^\/\*(?: beautify(?: (?:ignore|preserve):(?:start|end))+ |\sbeautify\signore:end\s)\*\/$/,
    rawText: true,
    blockOnly: true,
    name: "beautify",
  },
  // Coverage tools. The mode is part of the name so that consumers can tell
  // next-statement pragmas (`next`, `if`, ...) from file/range ones (`file`,
  // `start`, `stop`). The c8 CLI (v8-to-istanbul) and Node core only parse
  // block comments, but istanbul-lib-instrument and Vitest's v8 provider
  // (ast-v8-to-istanbul) honour line comments too, so no rule is block-only.
  { pattern: /^istanbul\s+ignore\s+([a-z]+)/, name: (match) => `istanbul-ignore-${match[1]}` },
  { pattern: /^istanbul\s+ignore\b/, name: "istanbul-ignore" },
  { pattern: /^c8\s+ignore\s+([a-z]+)/, name: (match) => `c8-ignore-${match[1]}` },
  { pattern: /^c8\s+ignore\b/, name: "c8-ignore" },
  { pattern: /^v8\s+ignore\s+([a-z]+)/, name: (match) => `v8-ignore-${match[1]}` },
  { pattern: /^v8\s+ignore\b/, name: "v8-ignore" },
  // Node core reads `node:coverage` with `ignore next [N]`, `disable` and
  // `enable`; Vitest's v8 provider also takes its `ignore` with `start`/`stop`
  // as a range, which gets a range name like the other tools'
  // (`node:coverage-ignore` stays the counted next-line pragma). Source text
  // must never spell a range pragma out: the v8 provider finds one on any line
  // of this file too, and would drop the rest of it from coverage.
  {
    pattern: /^node:coverage\s+(?:ignore\s+(start|stop)(?=\W|$)|(disable|enable|ignore)\b)/,
    name: (match) =>
      match[1] === undefined ? `node:coverage-${match[2] as string}` : `node:coverage-ignore-${match[1]}`,
  },
  // type-coverage: substring match in any comment. There is no ignore-file
  // comment — file-level ignores are a CLI option only.
  {
    pattern: /type-coverage:ignore-(next-line|line)/,
    name: (match) => `type-coverage:ignore-${match[1]}`,
    anyLine: true,
  },
  // StrykerJS mutation testing. The instrumenter runs
  // /^\s?Stryker (disable|restore)(?: (next-line))? ([a-zA-Z, ]+)/ against the
  // raw comment value: at most one space before `Stryker`, single literal
  // spaces, and a mandatory mutator list (`all` or names, which may itself
  // open with blanks or a comma) — hence the rawText match.
  {
    pattern: /^\/[/*]\s?Stryker (disable|restore)( next-line)? [a-zA-Z, ]/,
    rawText: true,
    name: (match) => `stryker-${match[1]}${match[2] === undefined ? "" : "-next-line"}`,
  },
  // ts-prune: substring of the closest leading comment above an export.
  { pattern: /ts-prune-ignore-next/, name: "ts-prune-ignore-next", anyLine: true },
  // typescript-strict-plugin. Its CLI splits `//` lines on spaces and compares
  // the tokens, so the pragma may sit anywhere on such a line; its IDE plugin
  // finds it with tsc's TODO-comment scan instead — case-insensitively, right
  // after the comment opener or a line's leading stars, and followed by
  // anything but an ASCII letter or digit (`@ts-strict-ignore: legacy`).
  { pattern: /(?:^|\s)@ts-strict(-ignore)?(?=\s|$)/, name: tsStrictName, anyLine: true },
  { pattern: /(?:^[\s*]*|\/\/+\s*|\/\*+\s*)@ts-strict(-ignore)?(?![A-Za-z0-9])/im, rawText: true, name: tsStrictName },
  // Flow. The pragmas live in the file's leading comments. Prettier's babel
  // parser switches to Flow syntax when /@(?:no)?flow\b/ matches anywhere in
  // the text before the first token (isFlowFile in its parse/babel.js), so
  // `foo@flow.com` or `@flow-strict` in a header comment is live to it; Flow's
  // own tokenised pragma (`@flow` as a whole word) is a subset of that.
  // Suppressions must open the comment and take an optional [error-code]
  // (Flow now requires one; older releases did not); all four historical
  // suppressors are recognised ($FlowIssue/$FlowIgnore stopped working in
  // Flow 0.281 but still gate older setups). flowlint takes rule:severity
  // pairs.
  {
    pattern: /@(no)?flow\b/,
    name: (match) => (match[1] === undefined ? "@flow" : "@noflow"),
    anyLine: true,
  },
  {
    pattern: /^\$Flow(FixMe|ExpectedError|Issue|Ignore)(?:\[[a-z-]+\])?(?![\w-])/,
    name: (match) => `$Flow${match[1]}`,
  },
  {
    pattern: /^flowlint(-line|-next-line)?\s+[a-z][a-z-]*\s*:\s*(?:off|warn|error)/,
    name: (match) => `flowlint${match[1] ?? ""}`,
    joinLines: true,
  },
  // Bundlers. webpack's gate regex requires the colon to follow the key
  // immediately and evaluates the body as an object literal, which JSDoc
  // stars break. Turbopack reads the whole trimmed comment as one `key:
  // value` pair instead — blanks before the colon allowed — and honours
  // webpackIgnore and webpackExports as well as its own keys.
  { pattern: /^webpack[A-Z][A-Za-z]+:/, name: "webpack-magic-comment", keepStars: true },
  {
    pattern: /^(?:turbopack[A-Z][A-Za-z]+|webpack(?:Ignore|Exports))\s*:/,
    name: "turbopack-magic-comment",
    keepStars: true,
  },
  // Vite matches the literal block comment (`/\/\*\s*@vite-ignore\s*\*\//` in
  // importAnalysis), so line comments, suffixes and trailing words stay
  // ordinary.
  { pattern: /^\/\*\s*@vite-ignore\s*\*\/$/, rawText: true, blockOnly: true, name: "@vite-ignore" },
  // Terser/Rollup annotations: a bare substring search over any comment kind,
  // so leading or trailing words keep the annotation active.
  { pattern: /[#@]__(?:PURE|NO_SIDE_EFFECTS|INLINE|NOINLINE|KEY|MANGLE_PROP)__/, anyLine: true },
  // Million.js: substring of the leading comments of a component; the skip
  // annotations are compared with the whole trimmed comment value.
  { pattern: /million-ignore/, name: "million-ignore", anyLine: true },
  {
    pattern: /^@million (jsx-)?skip$/,
    joinLines: true,
    keepStars: true,
    name: (match) => (match[1] === undefined ? "@million-skip" : "@million-jsx-skip"),
  },
  // Nx project graph: substring; the comment has to end on the line right
  // above the import it hides.
  { pattern: /nx-ignore-next-line/, name: "nx-ignore-next-line", anyLine: true },
  // UnoCSS: include/ignore (and the language server's ide-include) are raw
  // whole-file substring checks; the skip markers must be their own comment.
  {
    pattern: /@unocss-(include|ignore|ide-include)/,
    name: (match) => `@unocss-${match[1]}`,
    anyLine: true,
  },
  { pattern: /^@unocss-skip-(start|end)\b/, name: (match) => `@unocss-skip-${match[1]}` },
  // Next.js codemod markers: `next build` fails while an unresolved
  // @next-codemod-error comment is attached to the call.
  { pattern: /@next-codemod-(error|ignore)/, name: (match) => `@next-codemod-${match[1]}`, anyLine: true },
  // Bun: the runtime treats a file whose first line, or whose line right after
  // a `#!` line, starts with the literal bytes `// @bun` (optionally followed
  // by flags like `@bytecode`) as already transpiled.
  { pattern: /^\/\/ @bun/, rawText: true, lineOnly: true, name: "@bun" },
  // React Fast Refresh / solid-refresh. react-refresh looks for the
  // substring `@refresh reset` in any comment; solid-refresh requires its
  // pragma to be the entire trimmed comment value.
  {
    pattern: /^@refresh (skip|reload|jsx-skip)$/,
    joinLines: true,
    keepStars: true,
    name: (match) => `@refresh-${match[1]}`,
  },
  { pattern: /@refresh reset/, name: "@refresh-reset", anyLine: true },
  // Embedded-language tag comments: prettier formats the following template
  // literal when the whole comment is `GraphQL` (graphql-tag-pluck compares
  // the trimmed value case-insensitively) or `HTML` (prettier's exact ` HTML `
  // value).
  { pattern: /^graphql$/i, joinLines: true, keepStars: true, name: "GraphQL" },
  { pattern: /^\/\* HTML \*\/$/, rawText: true, blockOnly: true, name: "HTML" },
  // Source maps (`//# sourceMappingURL=`, legacy `//@`, and the block form).
  // deno_graph matches the name in any case and allows blanks around the `=`.
  {
    pattern: /^[#@]\s*(source(?:Mapping)?URL)\s*=/i,
    name: (match) => ((match[1] as string).toLowerCase() === "sourceurl" ? "sourceURL" : "sourceMappingURL"),
  },
  // Test runners. Jest reads these from the file's leading docblock, but
  // Vitest (which also honours the @jest- spellings) matches the pragma with
  // a bare regex over the whole file, so any comment kind and position can be
  // active; both regexes require a value after the tag.
  {
    pattern: /@((?:jest|vitest)-environment)\s+[\w-]/,
    name: (match) => `@${match[1]}`,
    anyLine: true,
  },
  {
    pattern: /@((?:jest|vitest)-environment-options)\s+\S/,
    name: (match) => `@${match[1]}`,
    anyLine: true,
  },
  // Vitest module tags: /(\/\/|\*)\s*@module-tag\s+([\w\-/]+)\b/ over the
  // whole file, so the tag has to follow a `//` or a `*` — any of the
  // comment's — with only whitespace between.
  { pattern: /(?:\/\/|\*)\s*@module-tag\s+[\w/-]*\w/, rawText: true, name: "@module-tag" },
  // SonarQube/SonarCloud (SonarJS): the comment value, minus ONE leading `*`,
  // trimmed, has to START with NOSONAR, case-insensitively; any suffix keeps
  // it active. A star-prefixed line inside a block comment does not count.
  { pattern: /^\/[/*]\*?\s*NOSONAR/i, rawText: true, name: "NOSONAR" },
  // Semgrep: ` nosemgrep`/` nosem` (case-insensitive) on the finding line or
  // standalone above it, with optional `:`/`=` rule ids. Semgrep itself needs
  // no trailing boundary; the lookahead just keeps words like `nosemantic`
  // ordinary.
  { pattern: /(?:^|\s)nosem(?:grep)?(?![\w-])/i, name: "nosemgrep", anyLine: true },
  // CodeQL / LGTM alert suppressions: the JavaScript AlertSuppression query
  // reads every comment whose text holds no line feed — `//` comments and
  // single-line block comments alike. `lgtm[...]` matches anywhere in the
  // text; bare `lgtm` only at its start or after a `;`; `codeql[...]` requires
  // the bracketed query id.
  { pattern: /\blgtm\s*\[[^\]]*\]/i, rawText: true, singleLine: true, name: "lgtm" },
  { pattern: /(?:^\/[/*]|;)\s*lgtm(?!\w)(?!\s*\[)/i, rawText: true, singleLine: true, name: "lgtm" },
  { pattern: /\bcodeql\s*\[[^\]]*\]/i, rawText: true, singleLine: true, name: "codeql" },
  // DeepSource: bare `skipcq` or `skipcq: CODE1, CODE2`, on the flagged line
  // or standalone above it (it may trail other comment text).
  { pattern: /\bskipcq(?![\w-])/, name: "skipcq", anyLine: true },
  // Snyk Code (DeepCode, legacy): `deepcode ignore RuleId: reason`, with a
  // `file ` prefix for the file-wide form.
  { pattern: /^(?:file\s+)?deepcode\s+ignore\b/, name: "deepcode-ignore" },
  // Datadog static analysis: the keyword must directly follow the comment
  // opener (whitespace aside); a `/**` star defeats it. Applies to the next
  // line, or the whole file from line 1.
  { pattern: /^(no-dd-sa|datadog-disable)/, notDocblock: true, name: (match) => match[1] as string },
  // Secret scanners: raw substring checks on the finding line.
  { pattern: /gitleaks:allow/, name: "gitleaks:allow", anyLine: true },
  { pattern: /trufflehog:ignore/, name: "trufflehog:ignore", anyLine: true },
  // detect-secrets: `pragma: allowlist secret` (legacy `whitelist`) on the
  // finding line, or the nextline form standing alone above it.
  { pattern: /^pragma: ?allowlist[ -]nextline[ -]secret/, name: "pragma-allowlist-nextline-secret" },
  { pattern: /^pragma: ?(?:allow|white)list[ -]secret/, name: "pragma-allowlist-secret" },
  // cspell in-document directives: `\b(?:spell-?checker|c?spell)::?` (yes,
  // bare `spell:` counts) anywhere in the text, case-insensitive, followed by
  // one of the known directive verbs. Names are normalised to `cspell:<verb>`.
  {
    pattern:
      /\b(?:c?spell|spell-?checker)::?\s*(disable(?:-line|-next(?:-line)?)?|enable|ignore(?:-?words?)?|words?|(?:flag|forbid)(?:-?words?)?|ignore_?reg_?exp|include_?reg_?exp|dictionar(?:y|ies)|locale?|language|(?:enable|disable)(?:allow)?compoundwords|(?:enable|disable)casesensitive)\b(?!-)/i,
    name: (match) => `cspell:${(match[1] as string).toLowerCase()}`,
    anyLine: true,
  },
  // cspell's legacy emacs-style word list (case-sensitive, colon optional).
  { pattern: /\bLocalWords(?::|\s+\S)/, name: "LocalWords", anyLine: true },
  // codespell: the tag must follow a punctuation character (the comment
  // marker itself at line starts), with any whitespace between.
  {
    pattern: /(?:^|[^\w\s]\s*)codespell:ignore(?:(-next-line)\b|(?![\w-]))/,
    name: (match) => `codespell:ignore${match[1] ?? ""}`,
    anyLine: true,
  },
  // JetBrains IDEs. `noinspection` suppressions are line comments in JS/TS
  // (`//\s*noinspection\s+ids`, or `//file:noinspection` for the whole file)
  // and take comma-separated inspection ids; editor-fold markers are
  // substring checks; a `language=` comment injects a language into the
  // literal that follows.
  { pattern: /^\/\/(?:file:)?\s*noinspection\s+[\w.-]+/, rawText: true, lineOnly: true, name: "noinspection" },
  {
    pattern: /<(\/?)editor-fold/,
    name: (match) => (match[1] === "/" ? "editor-fold-end" : "editor-fold"),
    anyLine: true,
  },
  { pattern: /^language=\S/, name: "language-injection" },
  // ReSharper/Rider suppressions (`ReSharper disable once RuleName`, ...).
  { pattern: /^ReSharper (disable|restore)\b/, lineOnly: true, name: (match) => `resharper-${match[1]}` },
  // Editor folding regions: VS Code folds `// #region` and `// region`
  // comments (`^\s*//\s*#?region\b`), IntelliJ any comment that opens with
  // marker characters, blanks and `region` (`[/*#-]*\s*region.*`).
  { pattern: /^[/*#-]*\s*#?(region|endregion)\b/, rawText: true, name: (match) => `#${match[1] as string}` },
  // Rules that match anywhere in the comment text come after every anchored
  // rule, so a tool's own directive that merely mentions another tool's
  // marker keeps its name — and, for a next-line directive, the shield that
  // goes with it (`// nosemgrep: ... @jsx h` stays a Semgrep suppression).
  //
  // React Compiler (babel-plugin-react-compiler, and Bun's port of it) skips a
  // component whose comments suppress its react-hooks rules: it searches each
  // comment for `eslint-disable`/`-next-line`/`eslint-enable` followed by one
  // of the rules, anywhere in the text — JSDoc blocks and mid-text mentions
  // included — and for a Flow suppression of its `react-rule-*` errors.
  {
    pattern: /eslint-(disable(?:-next-line)?|enable)\s[^]*react-hooks\/(?:exhaustive-deps|rules-of-hooks)/,
    rawText: true,
    name: (match) => `eslint-${match[1] as string}`,
  },
  {
    pattern: /\$(?:(FlowFixMe)\w*|(FlowExpectedError|FlowIssue))\[react-rule/,
    rawText: true,
    name: (match) => `$${match[1] ?? match[2]}`,
  },
  // ast-v8-to-istanbul finds `ignore start`/`stop` ranges with a plain text
  // search over every line, so those count after any other text as well.
  {
    pattern: /(istanbul|[cv]8|node:coverage)\s+ignore\s+(start|stop)(?=\W|$)/,
    name: (match) => `${match[1] as string}-ignore-${match[2] as string}`,
    anyLine: true,
  },
  // JSX pragmas. esbuild and Bun look at every `@` of every comment, Babel at
  // every comment line (its TypeScript plugin anywhere in the text), and the
  // oxc transformer at the leading comments — line comments included, all
  // case-sensitive, all needing whitespace and an argument after the name.
  // tsc lowercases the name of a block-comment pragma, and deno_graph matches
  // `@jsxImportSource(Types)` block comments in any case, so block comments
  // also match case-insensitively.
  {
    pattern: /@(jsx(?:Frag|Runtime|ImportSource)?)\s+\S/,
    joinLines: true,
    name: (match) => `@${match[1] as string}`,
  },
  {
    pattern: /@(jsx(?:frag|runtime|importsource(?:types)?)?)\s+\S/i,
    blockOnly: true,
    joinLines: true,
    name: (match) => JSX_PRAGMAS.get((match[1] as string).toLowerCase()),
  },
  // ESLint's no-fallthrough (in eslint:recommended) accepts a case that falls
  // through when the last comment before the next case matches
  // /falls?\s?through/iu anywhere in its value; oxlint's port and JSHint's
  // `/* falls through */` accept narrower forms of the same words. ESLint's and
  // oxlint's default-case accept a final comment that is exactly `no default`,
  // in any case. Both come last, so a tool's own directive that mentions the
  // words (`biome-ignore ...: fallthrough intended`) keeps its name.
  { pattern: /falls?\s?through/iu, rawText: true, name: "fallthrough" },
  { pattern: /^\/(?:\/\s*no default\s*|\*\s*no default\s*\*\/)$/iu, rawText: true, name: "no-default" },
];

// tsc 6 (the JavaScript compiler) reads triple-slash directives with
// tripleSlashXMLCommentStartRegEx: the directive name (matched
// case-insensitively) must be followed by whitespace and the tag has to close
// with `/>`, and the AMD directives additionally need their mandatory quoted
// argument, or the pragma is dropped altogether. tsc 7 (the Go port) has no
// AMD directives left and reads `reference` as a name of letters and hyphens
// that needs neither: `/// <reference types="node">` is a live type reference
// to it, and a bare `/// <reference>` a directive it rejects (TS1084).
const TRIPLE_SLASH = /^\/\/\/\s*<(reference|amd-dependency|amd-module)\s.*?\/>/i;
const TRIPLE_SLASH_REQUIRED_ARGUMENT: Readonly<Record<string, RegExp>> = {
  "amd-dependency": /\spath\s*=\s*(?:'[^']*'|"[^"]*")/i,
  "amd-module": /\sname\s*=\s*(?:'[^']*'|"[^"]*")/i,
};
const TS7_TRIPLE_SLASH_REFERENCE = /^\/\/\/[ \t]*<reference(?![A-Za-z-])/i;

/** The canonical triple-slash directive name the line comment carries, if either tsc would honour it. */
function tripleSlashDirective(text: string): string | undefined {
  const match = TRIPLE_SLASH.exec(text);
  if (match) {
    const name = (match[1] as string).toLowerCase();
    const requiredArgument = TRIPLE_SLASH_REQUIRED_ARGUMENT[name];
    if (requiredArgument === undefined || requiredArgument.test(text)) return `triple-slash-${name}`;
  }
  return TS7_TRIPLE_SLASH_REFERENCE.test(text) ? "triple-slash-reference" : undefined;
}

/**
 * Where a comment sits in its file, for directives that are only honoured in
 * particular positions. Omitting the placement treats every position as
 * valid, which matches how a lone comment string is best interpreted.
 */
export interface DirectivePlacement {
  /** The comment starts before the file's first token. */
  header: boolean;
  /** The comment is the file's first comment, preceded only by whitespace (or a shebang). */
  firstComment: boolean;
  /**
   * The comment starts where Bun looks for its `// @bun` marker: the very
   * first character of the file, or the first character after the line break
   * that ends a leading `#!` line (see bunMarkerOffset).
   */
  fileStart: boolean;
}

const ANY_PLACEMENT: DirectivePlacement = { header: true, firstComment: true, fileStart: true };

/**
 * The offset at which Bun reads its `// @bun` marker (`has_bun_pragma` in its
 * parser): the start of the text, or, when the text opens with a `#!` line,
 * the character after that line's first `\n` — -1 when the shebang line is
 * the whole text, leaving no place for the marker.
 */
export function bunMarkerOffset(text: string): number {
  if (!text.startsWith("#!")) return 0;
  const lineFeed = text.indexOf("\n");
  return lineFeed === -1 ? -1 : lineFeed + 1;
}

// File-wide pragmas (check pragmas, triple-slash directives, Flow/JSLint
// header pragmas, Biome's top-level suppression, Deno's lint file pragma,
// dprint/deno fmt file pragmas and @ts-self-types) only count before the first
// token; anywhere later the tools treat them as ordinary text — or, for a
// stray dprint/deno fmt file pragma, as the node pragma it contains, which the
// next rule then reports. Coverage file pragmas (`istanbul ignore file`,
// `c8/v8 ignore file`) are NOT gated: istanbul-lib-instrument and Vitest's v8
// provider (ast-v8-to-istanbul) honour them on any comment in the file. Test
// environment pragmas are not gated either: Vitest matches them (including
// the @jest- spellings) with a regex over the whole file, and neither are
// @ts-strict pragmas (typescript-strict-plugin scans every line). @jsx
// pragmas stay ungated too: tsc only reads leading ones, but Babel's JSX
// transform scans every comment in the file.
const HEADER_ONLY_DIRECTIVES = new Set([
  "@ts-nocheck",
  "@ts-check",
  "@flow",
  "@noflow",
  "@ts-self-types",
  "jslint",
  "property",
  "biome-ignore-all",
  "deno-lint-ignore-file",
  "dprint-ignore-file",
  "deno-fmt-ignore-file",
]);

// Prettier's pragma mode reads the pragma through jest-docblock, which only
// ever extracts the file's FIRST comment (a shebang may precede it) — a
// docblock behind any other comment is ignored. Cross-checked against the
// real prettier in directives.prettier.test.ts. Deno's coverage reads its
// file pragma from the first comment alone, too.
const FIRST_COMMENT_ONLY_DIRECTIVES = new Set([
  "@format",
  "@noformat",
  "@prettier",
  "@noprettier",
  "deno-coverage-ignore-file",
]);

// Bun treats a file as pre-transpiled only when `// @bun` opens it or the
// line after its shebang; anywhere else the marker is inert.
const FILE_START_ONLY_DIRECTIVES = new Set(["@bun"]);

function isActiveAt(name: string, placement: DirectivePlacement): boolean {
  if (FILE_START_ONLY_DIRECTIVES.has(name)) return placement.fileStart;
  if (FIRST_COMMENT_ONLY_DIRECTIVES.has(name)) return placement.firstComment;
  if (HEADER_ONLY_DIRECTIVES.has(name) || name.startsWith("triple-slash-")) {
    return placement.header;
  }
  return true;
}

// Mirrors the TypeScript compilers' own comment-directive matching, verified
// against tsc 6.0 and 7.0 (a comment counts when either honours it). The
// suppression directives are case-sensitive PREFIX matches (`@ts-ignoreTODO`
// is active). In `//` comments tsc 6 allows one extra slash and any
// whitespace before the `@`, tsc 7 any number of extra slashes but only
// spaces and tabs — so `//// @ts-ignore` is live to tsc 7 alone.
const TS_LINE_SUPPRESSION = /^\/\/(?:\/?\s*|\/*[ \t]*)@ts-(ignore|expect-error)/;
// The file-wide check pragmas go through each compiler's case-insensitive
// pragma parser. tsc 6 reads the name up to the next whitespace or colon
// (`@ts-nocheck:reason` is active, `@ts-nocheckfoo` and `@ts-nocheck-foo` are
// not); tsc 7 reads it as a run of ASCII letters and hyphens after spaces and
// tabs only, so `@ts-nocheck.` and `@ts-nocheck1` are active to it.
const TS6_LINE_CHECK_PRAGMA = /^\/\/\/?\s*@ts-(nocheck|check)(?=[^\S\r\n]|:|$)/i;
const TS7_LINE_CHECK_PRAGMA = /^\/\/\/?[ \t]*@ts-(nocheck|check)(?![A-Za-z-])/i;
// Block comments: only the suppression directives, and only on the comment's
// literal last line (`*/` included), even when that line is otherwise blank.
// tsc trims the line and then allows one run of `/`/`*` characters before the
// directive, so `* @ts-ignore */` counts but `/ * @ts-ignore */` does not.
const TS_BLOCK_SUPPRESSION = /^\s*[/*]*\s*@ts-(ignore|expect-error)/;
// Flow, which also checks TypeScript files, honours the same suppressions
// there with its own matching: the directive must OPEN the comment value,
// after any spaces, tabs, line breaks and stars — in a block comment
// whatever its last line holds — and end where an identifier would
// (`@ts-ignore: reason` counts, `@ts-ignoree` does not).
const FLOW_LINE_SUPPRESSION = /^\/\/[ \t*]*@ts-(ignore|expect-error)(?![\w-])/;
const FLOW_BLOCK_SUPPRESSION = /^\/\*[ \t\r\n*]*@ts-(ignore|expect-error)(?![\w-])/;

/**
 * Returns the canonical name of the compiler/linter/tooling directive the
 * comment represents, or `undefined` when the comment is an ordinary comment.
 *
 * When a placement is given, directives that the corresponding tool only
 * honours in certain positions (header pragmas, prettier's docblock pragma,
 * `// @bun`) are skipped elsewhere — and the remaining rules still run, so a
 * live directive later in the same comment (`// deno-lint-ignore-file
 * nosemgrep` in mid-file) is not masked by a positionally dead one.
 */
export function detectDirective(kind: CommentKind, text: string, placement?: DirectivePlacement): string | undefined {
  const at = placement ?? ANY_PLACEMENT;
  if (kind === "line") {
    const tripleSlash = tripleSlashDirective(text);
    if (tripleSlash !== undefined && isActiveAt(tripleSlash, at)) return tripleSlash;
    const suppression = TS_LINE_SUPPRESSION.exec(text) ?? FLOW_LINE_SUPPRESSION.exec(text);
    if (suppression) {
      return `@ts-${suppression[1]}`;
    }
    const checkPragma = TS6_LINE_CHECK_PRAGMA.exec(text) ?? TS7_LINE_CHECK_PRAGMA.exec(text);
    if (checkPragma) {
      const name = `@ts-${checkPragma[1]?.toLowerCase()}`;
      if (isActiveAt(name, at)) return name;
    }
  } else {
    const suppression = TS_BLOCK_SUPPRESSION.exec(lastLine(text)) ?? FLOW_BLOCK_SUPPRESSION.exec(text);
    if (suppression) {
      return `@ts-${suppression[1]}`;
    }
  }

  for (const name of ruleMatches(kind, text)) {
    if (isActiveAt(name, at)) return name;
  }
  return undefined;
}

/** Directive names of every rule the comment matches, in rule order. */
function* ruleMatches(kind: CommentKind, text: string): Generator<string> {
  const lines = contentLines(kind, text, false);
  const literalLines = kind === "block" ? contentLines(kind, text, true) : lines;
  for (const rule of RULES) {
    if (rule.blockOnly === true && kind !== "block") continue;
    if (rule.lineOnly === true && kind !== "line") continue;
    if (rule.singleLine === true && text.includes("\n")) continue;
    if (rule.notDocblock === true && kind === "block" && text.startsWith("/**")) continue;
    const ruleLines = rule.keepStars === true ? literalLines : lines;
    const candidates =
      rule.rawText === true
        ? [text]
        : rule.anyLine === true
          ? ruleLines
          : rule.joinLines === true
            ? [ruleLines.join(" ")]
            : ruleLines.slice(0, 1);
    for (const line of candidates) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      const name =
        typeof rule.name === "string" ? rule.name : typeof rule.name === "function" ? rule.name(match) : match[0];
      if (name === undefined) continue;
      if (typeof name === "string") yield name;
      else yield* name;
    }
  }
}

/**
 * The position-dependent directives (prettier's first-comment pragmas, Deno's
 * coverage file pragma, Bun's file-start marker) the comment carries that are
 * active at the given placement, sorted. Unlike detectDirective — which
 * reports one canonical name — this sees through masking: an eslint config
 * block can also hold a `@format` pragma, and whether that pragma is live
 * must not hide behind the name an earlier rule already claimed. Only
 * first-comment and file-start gates are consulted; header-gated directives
 * cannot change activation when the comments around them change.
 */
export function activePositionalDirectives(kind: CommentKind, text: string, placement: DirectivePlacement): string[] {
  const names = new Set<string>();
  for (const name of ruleMatches(kind, text)) {
    if (!FIRST_COMMENT_ONLY_DIRECTIVES.has(name) && !FILE_START_ONLY_DIRECTIVES.has(name)) continue;
    if (isActiveAt(name, placement)) names.add(name);
  }
  return [...names].sort();
}

/**
 * True for license/legal comments (`/*!`, `@license`, `@preserve`,
 * `@copyright`, and the machine-readable `SPDX-License-Identifier:` /
 * `SPDX-FileCopyrightText:` tags) that build tools conventionally keep when
 * stripping comments and that license scanners rely on.
 */
export function isLegalComment(text: string): boolean {
  if (text.startsWith("/*!") || text.startsWith("//!")) return true;
  if (/\bSPDX-(?:License-Identifier|FileCopyrightText):/i.test(text)) return true;
  return /@(?:license|preserve|copyright)\b/i.test(text);
}

/**
 * Non-empty content lines of the comment, with comment markers stripped.
 * For line comments only the `//` marker itself is removed: extra slashes or
 * stars are content, so `/// eslint-disable-line` and `// * prettier-ignore`
 * stay ordinary. JSDoc-style `*` prefixes are stripped for block comments unless
 * `keepStars` asks for the literal lines (for tools that compare the raw
 * comment value, where a leading `*` defeats the directive).
 */
function contentLines(kind: CommentKind, text: string, keepStars: boolean): string[] {
  // In keepStars mode only the literal `/*` and `*/` markers go, matching how
  // prettier/oxfmt read the comment value: the second star of a `/**` opener
  // is content and defeats their exact comparison.
  const inner =
    kind === "line"
      ? text.replace(/^\/\//, "")
      : keepStars
        ? text.replace(/^\/\*/, "").replace(/\*\/\s*$/, "")
        : text.replace(/^\/\*+/, "").replace(/\*+\/\s*$/, "");
  const lines: string[] = [];
  for (const line of splitLines(inner)) {
    const stripped = (kind === "block" && !keepStars ? line.replace(/^\s*\*+\s*/, "") : line).trim();
    if (stripped !== "") lines.push(stripped);
  }
  return lines;
}
