import type { CommentKind } from "./types.js";

interface DirectiveRule {
  pattern: RegExp;
  /** Fixed name, or derive it from the match. Defaults to the full matched text. */
  name?: string | ((match: RegExpExecArray) => string);
  blockOnly?: boolean;
  /** Only match line comments (e.g. JetBrains suppressions in JS/TS). */
  lineOnly?: boolean;
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
   * Skip `/**`-opened block comments: webpack evaluates the comment body as
   * an object literal (JSDoc stars break it), and dprint/datadog skip only
   * whitespace before their marker, so a leading `*` defeats them.
   */
  notDocblock?: boolean;
  /**
   * Match content lines verbatim, without stripping JSDoc `*` prefixes, for
   * tools that compare the literal comment value (prettier/oxfmt compare the
   * trimmed body, so `/** prettier-ignore *​/` is NOT a suppression to them).
   */
  keepStars?: boolean;
}

const RULES: DirectiveRule[] = [
  // ESLint
  { pattern: /^eslint-(?:disable|enable)(?:-next-line|-line)?\b/ },
  { pattern: /^eslint-env\b/ },
  { pattern: /^eslint\s+\S/, name: "eslint", blockOnly: true, joinLines: true },
  {
    pattern: /^(globals?|exported)\s+\S/,
    name: (match) => match[1] as string,
    blockOnly: true,
    joinLines: true,
  },
  // TSLint (legacy)
  { pattern: /^tslint:[a-z-]+/ },
  // JSHint (legacy): `key: value` options and ignore markers (`jshint
  // esversion: 6`, `jshint ignore:line`) plus `-W###`/`+W###` warning toggles.
  // Requiring those shapes keeps prose like `jshint is unused` ordinary.
  { pattern: /^jshint\s+(?:[A-Za-z$_][\w$]*\s*:|[-+]W\d+\b)/, name: "jshint", joinLines: true },
  // JSCS (legacy). Spacing after the colon is lenient (`jscs: enable` works),
  // so the name is normalised to the compact form.
  { pattern: /^jscs:\s*(disable|enable|ignore)\b/, name: (match) => `jscs:${match[1]}`, joinLines: true },
  // JSLint (legacy): the directive word must sit immediately after the
  // comment marker with no space (`/*jslint devel*/` works, `/* jslint */`
  // does not) and needs a body, so these match the raw text. The whole-line
  // pragmas (`/*jslint-disable*/`, `//jslint-ignore-line`) are exact strings.
  { pattern: /^\/[/*](jslint|property)\s+\S/, rawText: true, name: (match) => match[1] as string },
  { pattern: /^\/\*jslint-(disable|enable)\*\/$/, rawText: true, name: (match) => `jslint-${match[1]}` },
  { pattern: /^\/\/jslint-(ignore-line|quiet)$/, rawText: true, name: (match) => `jslint-${match[1]}` },
  // oxlint
  { pattern: /^oxlint-(?:disable|enable)(?:-next-line|-line)?\b/ },
  // Biome
  { pattern: /^biome-ignore(?:-all|-start|-end)?\b/ },
  // Rome (Biome's predecessor). Case-insensitive keyword with `-` or `_`,
  // then known categories and a mandatory colon — without the colon Rome
  // reported a parse diagnostic and the suppression stayed inert.
  {
    pattern: /^rome[-_]ignore\s*(?:(?:parse|format|lint)(?:\([^)]*\))?\s*)+:/i,
    name: "rome-ignore",
    anyLine: true,
  },
  // Deno
  { pattern: /^deno-(?:lint-ignore(?:-file)?|fmt-ignore(?:-file)?|coverage-ignore(?:-file|-start|-stop)?)\b/ },
  // Deno type directives. deno_graph matches them case-insensitively at the
  // comment start; `@deno-types` accepts a bare specifier, the newer names
  // require quotes.
  { pattern: /^@deno-types\s*=\s*(?:"[^"\n]+"|'[^'\n]+'|\S+)/i, name: "@deno-types" },
  { pattern: /^@ts-types\s*=\s*(?:"[^"\n]+"|'[^'\n]+')/i, name: "@ts-types" },
  { pattern: /^@ts-self-types\s*=\s*(?:"[^"\n]+"|'[^'\n]+')/i, name: "@ts-self-types" },
  // Formatter suppressions (prettier, and oxfmt which mirrors it). Both
  // parsers compare the exact trimmed comment body, so the marker must be the
  // whole comment (joinLines makes `$` span every line): hyphenated
  // lookalikes (`oxfmt-ignore-more`) and prose stay ordinary. keepStars,
  // because the literal comparison also means a JSDoc `*` before the marker
  // (`/** prettier-ignore *​/`) leaves the comment ordinary — verified against
  // prettier 3.8.
  { pattern: /^prettier-ignore(?:-start|-end)?$/, joinLines: true, keepStars: true },
  { pattern: /^oxfmt-ignore$/, joinLines: true, keepStars: true },
  // dprint. The file pragma is a starts-with check (trailing text allowed) on
  // the file's leading comments, skipping only whitespace — a `/**` docblock
  // star defeats it. The node pragma is a substring bounded by
  // non-alphanumerics anywhere in the comment, so a reason may follow.
  { pattern: /^dprint-ignore-file/, notDocblock: true, name: "dprint-ignore-file" },
  {
    pattern: /(?:^|[^\p{L}\p{N}])dprint-ignore(?![\p{L}\p{N}])/u,
    name: "dprint-ignore",
    anyLine: true,
  },
  // Prettier pragma mode (--require-pragma / --check-ignore-pragma). Prettier
  // reads them via jest-docblock: only the file's first block comment counts
  // and the pragma has to open a line. The lookahead keeps distinct keys like
  // `@prettier-plugin` ordinary, matching jest-docblock's `@(\S+)` parsing.
  { pattern: /^@(?:no)?(?:format|prettier)(?=\s|$)/, blockOnly: true, anyLine: true },
  // prettier-plugin-organize-imports: a literal whole-file substring check,
  // `//` and single space included, so it matches the raw comment text.
  { pattern: /\/\/ organize-imports-ignore/, rawText: true, name: "organize-imports-ignore" },
  // js-beautify (legacy): exact-shape block comments with single spaces; only
  // the ignore/preserve pairs have an effect.
  {
    pattern: /^\/\* beautify(?: (?:ignore|preserve):(?:start|end))+ \*\/$/,
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
  {
    pattern: /^node:coverage\s+(disable|enable|ignore)\b/,
    name: (match) => `node:coverage-${match[1]}`,
  },
  // type-coverage: substring match in any comment. There is no ignore-file
  // comment — file-level ignores are a CLI option only.
  {
    pattern: /type-coverage:ignore-(next-line|line)/,
    name: (match) => `type-coverage:ignore-${match[1]}`,
    anyLine: true,
  },
  // StrykerJS mutation testing. The instrumenter runs
  // /^\s?Stryker (disable|restore)( next-line)? <mutators>/ against the raw
  // comment value: at most one space before `Stryker`, single literal spaces,
  // and a mandatory mutator list (`all` or names) — hence the rawText match.
  {
    pattern: /^\/[/*]\s?Stryker (disable|restore)( next-line)? [a-zA-Z]/,
    rawText: true,
    name: (match) => `stryker-${match[1]}${match[2] === undefined ? "" : "-next-line"}`,
  },
  // ts-prune: substring of the closest leading comment above an export.
  { pattern: /ts-prune-ignore-next/, name: "ts-prune-ignore-next", anyLine: true },
  // typescript-strict-plugin: token-equality scan over the whole file (the
  // CLI splits comment lines on spaces, the IDE plugin uses a TODO scan).
  {
    pattern: /(?:^|\s)@ts-strict(-ignore)?(?=\s|$)/,
    name: (match) => (match[1] === undefined ? "@ts-strict" : "@ts-strict-ignore"),
    anyLine: true,
  },
  // Flow. The pragmas live in the file's leading docblock and are matched as
  // whole words (text may surround them). Suppressions must open the comment
  // and take an optional [error-code]; all four historical suppressors are
  // recognised ($FlowIssue/$FlowIgnore stopped working in Flow 0.281 but
  // still gate older setups). flowlint takes rule:severity pairs.
  {
    pattern: /(?:^|[\s*/])@(no)?flow(?=$|[\s*/])/,
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
  // stars break — turbopack magic comments mirror the same `key: value` form.
  { pattern: /^webpack[A-Z][A-Za-z]+:/, name: "webpack-magic-comment", notDocblock: true },
  { pattern: /^turbopack[A-Z][A-Za-z]+:/, name: "turbopack-magic-comment", notDocblock: true },
  // Vite matches the literal block comment (`/\/\*\s*@vite-ignore\s*\*\//` in
  // importAnalysis), so line comments, suffixes and trailing words stay
  // ordinary.
  { pattern: /^\/\*\s*@vite-ignore\s*\*\/$/, rawText: true, blockOnly: true, name: "@vite-ignore" },
  // Terser/Rollup annotations: a bare substring search over any comment kind,
  // so leading or trailing words keep the annotation active.
  { pattern: /[#@]__(?:PURE|NO_SIDE_EFFECTS|INLINE|NOINLINE|KEY|MANGLE_PROP)__/, anyLine: true },
  // Million.js: substring of the leading comments of a component.
  { pattern: /million-ignore/, name: "million-ignore", anyLine: true },
  {
    pattern: /^@million (jsx-)?skip$/,
    joinLines: true,
    name: (match) => (match[1] === undefined ? "@million-skip" : "@million-jsx-skip"),
  },
  // Nx project graph: substring; the comment has to end on the line right
  // above the import it hides.
  { pattern: /nx-ignore-next-line/, name: "nx-ignore-next-line", anyLine: true },
  // UnoCSS: include/ignore are raw whole-file substring checks; the skip
  // markers must be their own comment.
  { pattern: /@unocss-(include|ignore)/, name: (match) => `@unocss-${match[1]}`, anyLine: true },
  { pattern: /^@unocss-skip-(start|end)\b/, name: (match) => `@unocss-skip-${match[1]}` },
  // Next.js codemod markers: `next build` fails while an unresolved
  // @next-codemod-error comment is attached to the call.
  { pattern: /@next-codemod-(error|ignore)/, name: (match) => `@next-codemod-${match[1]}`, anyLine: true },
  // Bun: the runtime treats a file starting with the literal bytes `// @bun`
  // (optionally followed by flags like `@bytecode`) as already transpiled.
  { pattern: /^\/\/ @bun/, rawText: true, lineOnly: true, name: "@bun" },
  // React Fast Refresh / solid-refresh. react-refresh looks for the
  // substring `@refresh reset` in any comment; solid-refresh requires its
  // pragma to be the entire comment body.
  { pattern: /^@refresh (skip|reload)$/, joinLines: true, name: (match) => `@refresh-${match[1]}` },
  { pattern: /@refresh reset/, name: "@refresh-reset", anyLine: true },
  // Embedded-language tag comments: prettier formats the following template
  // literal when the whole comment is `GraphQL` (graphql-tag-pluck matches it
  // case-insensitively) or `HTML` (prettier's exact ` HTML ` value).
  { pattern: /^graphql$/i, joinLines: true, name: "GraphQL" },
  { pattern: /^\/\* HTML \*\/$/, rawText: true, blockOnly: true, name: "HTML" },
  // Source maps (`//# sourceMappingURL=`, legacy `//@`, and the block form)
  { pattern: /^[#@]\s*(source(?:Mapping)?URL)=/, name: (match) => match[1] as string },
  // JSX pragmas (docblock pragmas: block comments only, honoured on any line)
  { pattern: /^@jsx(?:Runtime|ImportSource|Frag)?\b/, blockOnly: true, anyLine: true },
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
  // Vitest module tags. Vitest requires the tag to sit right after a `//` or
  // `*` marker, which is what a content-line start means here.
  { pattern: /^@module-tag\s+[\w/-]/, name: "@module-tag", anyLine: true },
  // SonarQube/SonarCloud: the trimmed comment (JSDoc star stripped) has to
  // START with NOSONAR, case-insensitively; any suffix keeps it active.
  { pattern: /^NOSONAR/i, name: "NOSONAR" },
  // Semgrep: ` nosemgrep`/` nosem` (case-insensitive) on the finding line or
  // standalone above it, with optional `:`/`=` rule ids. Semgrep itself needs
  // no trailing boundary; the lookahead just keeps words like `nosemantic`
  // ordinary.
  { pattern: /(?:^|\s)nosem(?:grep)?(?![\w-])/i, name: "nosemgrep", anyLine: true },
  // CodeQL / LGTM alert suppressions: the AlertSuppression queries only read
  // `//` comments, so block comments — even single-line ones — stay ordinary.
  // `lgtm[...]` matches anywhere in the comment; bare `lgtm` only at the
  // start or after a `;`; `codeql[...]` requires the bracketed query id.
  { pattern: /\blgtm\s*\[[^\]]*\]/i, lineOnly: true, name: "lgtm" },
  { pattern: /(?:^|;)\s*lgtm(?!\w)(?!\s*\[)/i, lineOnly: true, name: "lgtm" },
  { pattern: /\bcodeql\s*\[[^\]]*\]/i, lineOnly: true, name: "codeql" },
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
  // marker itself at line starts) with at most one space between.
  {
    pattern: /(?:^|[^\w\s]\s?)codespell:ignore(-next-line)?(?![\w-])/,
    name: (match) => `codespell:ignore${match[1] ?? ""}`,
    anyLine: true,
  },
  // JetBrains IDEs. `noinspection` suppressions are line comments in JS/TS
  // and take comma-separated inspection ids; editor-fold markers are
  // substring checks; a `language=` comment injects a language into the
  // literal that follows.
  { pattern: /^noinspection\s+[A-Za-z0-9_.-]+/, lineOnly: true, name: "noinspection" },
  {
    pattern: /<(\/?)editor-fold/,
    name: (match) => (match[1] === "/" ? "editor-fold-end" : "editor-fold"),
    anyLine: true,
  },
  { pattern: /^language=\S/, name: "language-injection" },
  // ReSharper/Rider suppressions (`ReSharper disable once RuleName`, ...).
  { pattern: /^ReSharper (disable|restore)\b/, lineOnly: true, name: (match) => `resharper-${match[1]}` },
  // Editor folding
  { pattern: /^#(?:region|endregion)\b/ },
];

const TRIPLE_SLASH = /^\/\/\/\s*<(reference|amd-dependency|amd-module)\b/;

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
  /** The comment starts at the very first character of the file. */
  fileStart: boolean;
}

const ANY_PLACEMENT: DirectivePlacement = { header: true, firstComment: true, fileStart: true };

// File-wide pragmas (check pragmas, triple-slash directives, Flow/JSLint
// header pragmas, Deno's *-ignore-file and @ts-self-types forms) only count
// before the first token; anywhere later the tools treat them as ordinary
// text. dprint-ignore-file is deliberately absent: a stray one below the
// header no longer skips the file, but dprint's node pragma still matches
// inside it, so the comment stays an active `dprint-ignore` and must keep its
// tag. Coverage file pragmas (`istanbul ignore file`, `c8/v8 ignore file`)
// are NOT gated: istanbul-lib-instrument and Vitest's v8 provider
// (ast-v8-to-istanbul) honour them on any comment in the file. Test
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
]);

// Prettier's pragma mode reads the pragma through jest-docblock, which only
// ever extracts the file's FIRST comment (a shebang may precede it) — a
// docblock behind any other comment is ignored. Verified against prettier 3.8.
const FIRST_COMMENT_ONLY_DIRECTIVES = new Set(["@format", "@noformat", "@prettier", "@noprettier"]);

// Bun treats a file as pre-transpiled only when it literally STARTS with
// `// @bun`; after a shebang or any other leading content the marker is inert.
const FILE_START_ONLY_DIRECTIVES = new Set(["@bun"]);

function isActiveAt(name: string, placement: DirectivePlacement): boolean {
  if (FILE_START_ONLY_DIRECTIVES.has(name)) return placement.fileStart;
  if (FIRST_COMMENT_ONLY_DIRECTIVES.has(name)) return placement.firstComment;
  if (
    HEADER_ONLY_DIRECTIVES.has(name) ||
    (name.startsWith("deno-") && name.endsWith("-ignore-file")) ||
    name.startsWith("triple-slash-")
  ) {
    return placement.header;
  }
  return true;
}

// Mirrors the TypeScript compiler's own comment-directive matching, verified
// against tsc: the suppression directives are case-sensitive PREFIX matches
// (`@ts-ignoreTODO` is active), while the file-wide check pragmas are
// case-insensitive and must end at a word boundary (`@ts-nocheckfoo` is not).
const TS_LINE_SUPPRESSION = /^\/\/\/?\s*@ts-(ignore|expect-error)/;
const TS_LINE_CHECK_PRAGMA = /^\/\/\/?\s*@ts-(nocheck|check)\b/i;
// Block comments: only the suppression directives, and only on the comment's
// literal last line (`*/` included), even when that line is otherwise blank.
// tsc trims the line and then allows one run of `/`/`*` characters before the
// directive, so `* @ts-ignore */` counts but `/ * @ts-ignore */` does not.
const TS_BLOCK_SUPPRESSION = /^\s*[/*]*\s*@ts-(ignore|expect-error)/;

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
    const tripleSlash = TRIPLE_SLASH.exec(text);
    if (tripleSlash) {
      const name = `triple-slash-${tripleSlash[1]}`;
      if (isActiveAt(name, at)) return name;
    }
    const suppression = TS_LINE_SUPPRESSION.exec(text);
    if (suppression) {
      return `@ts-${suppression[1]}`;
    }
    const checkPragma = TS_LINE_CHECK_PRAGMA.exec(text);
    if (checkPragma) {
      const name = `@ts-${checkPragma[1]?.toLowerCase()}`;
      if (isActiveAt(name, at)) return name;
    }
  } else {
    const suppression = TS_BLOCK_SUPPRESSION.exec(lastLine(text));
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
      yield typeof rule.name === "string" ? rule.name : typeof rule.name === "function" ? rule.name(match) : match[0];
    }
  }
}

/**
 * The position-dependent directives (prettier's first-comment pragmas, Bun's
 * file-start marker) the comment carries that are active at the given
 * placement, sorted. Unlike detectDirective — which reports one canonical
 * name — this sees through masking: an eslint config block can also hold a
 * `@format` pragma, and whether that pragma is live must not hide behind the
 * name an earlier rule already claimed. Only first-comment and file-start
 * gates are consulted; header-gated directives cannot change activation when
 * the comments around them change.
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

// Every ECMAScript line terminator, the way the scanner breaks lines: CRLF as
// one break, plus lone LF / CR and the U+2028/U+2029 separators.
const LINE_BREAK = /\r\n|[\n\r\u2028\u2029]/;

/**
 * Non-empty content lines of the comment, with comment markers stripped.
 * For line comments only the `//` marker itself is removed: extra slashes or
 * stars are content, so `//// @ts-ignore` and `// * prettier-ignore` stay
 * ordinary. JSDoc-style `*` prefixes are stripped for block comments unless
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
  for (const line of inner.split(LINE_BREAK)) {
    const stripped = (kind === "block" && !keepStars ? line.replace(/^\s*\*+\s*/, "") : line).trim();
    if (stripped !== "") lines.push(stripped);
  }
  return lines;
}

/** Literal last line of the comment, closing marker included, exactly as tsc slices it. */
function lastLine(text: string): string {
  const lines = text.split(LINE_BREAK);
  return lines[lines.length - 1] as string;
}
