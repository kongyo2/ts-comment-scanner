import type { CommentKind } from "./types.js";

interface DirectiveRule {
  pattern: RegExp;
  /** Fixed name, or derive it from the match. Defaults to the full matched text. */
  name?: string | ((match: RegExpExecArray) => string);
  blockOnly?: boolean;
  /** Match any content line, not just the first (for docblock pragmas). */
  anyLine?: boolean;
}

const RULES: DirectiveRule[] = [
  // ESLint
  { pattern: /^eslint-(?:disable|enable)(?:-next-line|-line)?\b/ },
  { pattern: /^eslint-env\b/ },
  { pattern: /^eslint\s+\S/, name: "eslint", blockOnly: true },
  { pattern: /^(globals?|exported)\s+\S/, name: (match) => match[1] ?? "global", blockOnly: true },
  // TSLint (legacy)
  { pattern: /^tslint:[a-z-]+/ },
  // JSHint (legacy): options (`jshint esversion: 6`) and ignore markers
  // (`jshint ignore:line`, `jshint ignore:start`) share the one prefix.
  { pattern: /^jshint\s+\S/, name: "jshint" },
  // JSCS (legacy)
  { pattern: /^jscs:[a-z-]+/ },
  // oxlint
  { pattern: /^oxlint-(?:disable|enable)(?:-next-line|-line)?\b/ },
  // Biome
  { pattern: /^biome-ignore(?:-all|-start|-end)?\b/ },
  // Deno
  { pattern: /^deno-(?:lint-ignore(?:-file)?|fmt-ignore(?:-file)?|coverage-ignore(?:-file|-start|-stop)?)\b/ },
  // Prettier
  { pattern: /^prettier-ignore(?:-start|-end)?\b/ },
  // oxfmt (oxc's formatter; suppresses formatting of the next node, like prettier-ignore)
  { pattern: /^oxfmt-ignore\b/ },
  // Coverage tools. The mode is part of the name so that consumers can tell
  // next-statement pragmas (`next`, `if`, ...) from file/range ones (`file`,
  // `start`, `stop`). Istanbul hints work in either comment kind; the V8-based
  // tools (c8, v8, node:coverage) only document and parse block comments.
  { pattern: /^istanbul\s+ignore\s+([a-z]+)/, name: (match) => `istanbul-ignore-${match[1]}` },
  { pattern: /^istanbul\s+ignore\b/, name: "istanbul-ignore" },
  { pattern: /^c8\s+ignore\s+([a-z]+)/, name: (match) => `c8-ignore-${match[1]}`, blockOnly: true },
  { pattern: /^c8\s+ignore\b/, name: "c8-ignore", blockOnly: true },
  { pattern: /^v8\s+ignore\s+([a-z]+)/, name: (match) => `v8-ignore-${match[1]}`, blockOnly: true },
  { pattern: /^v8\s+ignore\b/, name: "v8-ignore", blockOnly: true },
  {
    pattern: /^node:coverage\s+(disable|enable|ignore)\b/,
    name: (match) => `node:coverage-${match[1]}`,
    blockOnly: true,
  },
  // Bundlers. Turbopack magic comments mirror webpack's `key: value` form
  // (`turbopackIgnore: true`, `turbopackOptional: true`, ...).
  { pattern: /^webpack[A-Z][A-Za-z]*\s*:/, name: "webpack-magic-comment" },
  { pattern: /^turbopack[A-Z][A-Za-z]*\s*:/, name: "turbopack-magic-comment" },
  { pattern: /^@vite-ignore\b/ },
  { pattern: /^[#@]__(?:PURE|NO_SIDE_EFFECTS|INLINE|NOINLINE)__/ },
  // Source maps (`//# sourceMappingURL=`, legacy `//@`, and the block form)
  { pattern: /^[#@]\s*(source(?:Mapping)?URL)=/, name: (match) => match[1] ?? "sourceMappingURL" },
  // JSX pragmas (docblock pragmas: block comments only, honoured on any line)
  { pattern: /^@jsx(?:Runtime|ImportSource|Frag)?\b/, blockOnly: true, anyLine: true },
  // Test runners (docblock pragmas as well)
  { pattern: /^@(?:jest|vitest)-environment\b/, blockOnly: true, anyLine: true },
  // Editor folding
  { pattern: /^#(?:region|endregion)\b/ },
];

const TRIPLE_SLASH = /^\/\/\/\s*<(reference|amd-dependency|amd-module)\b/;

// Mirrors the TypeScript compiler's own comment-directive matching, verified
// against tsc: the suppression directives are case-sensitive PREFIX matches
// (`@ts-ignoreTODO` is active), while the file-wide check pragmas are
// case-insensitive and must end at a word boundary (`@ts-nocheckfoo` is not).
const TS_LINE_SUPPRESSION = /^\/\/\/?\s*@ts-(ignore|expect-error)/;
const TS_LINE_CHECK_PRAGMA = /^\/\/\/?\s*@ts-(nocheck|check)\b/i;
// Block comments: only the suppression directives, and only on the last line.
const TS_BLOCK_SUPPRESSION = /^[\s/*]*@ts-(ignore|expect-error)/;

/**
 * Returns the canonical name of the compiler/linter/tooling directive the
 * comment represents, or `undefined` when the comment is an ordinary comment.
 */
export function detectDirective(kind: CommentKind, text: string): string | undefined {
  if (kind === "line") {
    const tripleSlash = TRIPLE_SLASH.exec(text);
    if (tripleSlash) {
      return `triple-slash-${tripleSlash[1]}`;
    }
    const suppression = TS_LINE_SUPPRESSION.exec(text);
    if (suppression) {
      return `@ts-${suppression[1]}`;
    }
    const checkPragma = TS_LINE_CHECK_PRAGMA.exec(text);
    if (checkPragma) {
      return `@ts-${checkPragma[1]?.toLowerCase()}`;
    }
  } else {
    const suppression = TS_BLOCK_SUPPRESSION.exec(lastContentLine(text));
    if (suppression) {
      return `@ts-${suppression[1]}`;
    }
  }

  const lines = contentLines(kind, text);
  for (const rule of RULES) {
    if (rule.blockOnly === true && kind !== "block") continue;
    const candidates = rule.anyLine === true ? lines : lines.slice(0, 1);
    for (const line of candidates) {
      const match = rule.pattern.exec(line);
      if (!match) continue;
      if (typeof rule.name === "string") return rule.name;
      if (typeof rule.name === "function") return rule.name(match);
      return match[0];
    }
  }
  return undefined;
}

/**
 * True for license/legal comments (`/*!`, `@license`, `@preserve`, `@copyright`)
 * that build tools conventionally keep when stripping comments.
 */
export function isLegalComment(text: string): boolean {
  if (text.startsWith("/*!") || text.startsWith("//!")) return true;
  return /@(?:license|preserve|copyright)\b/i.test(text);
}

/**
 * Non-empty content lines of the comment, with comment markers stripped.
 * For line comments only the `//` marker itself is removed: extra slashes or
 * stars are content, so `//// @ts-ignore` and `// * prettier-ignore` stay
 * ordinary. JSDoc-style `*` prefixes are stripped for block comments only.
 */
function contentLines(kind: CommentKind, text: string): string[] {
  const inner = kind === "line" ? text.replace(/^\/\//, "") : text.replace(/^\/\*+/, "").replace(/\*+\/\s*$/, "");
  const lines: string[] = [];
  for (const line of inner.split(/\r?\n/)) {
    const stripped = (kind === "block" ? line.replace(/^\s*\*+\s*/, "") : line).trim();
    if (stripped !== "") lines.push(stripped);
  }
  return lines;
}

/** Last non-blank line of the comment, with the closing comment marker stripped. */
function lastContentLine(text: string): string {
  const inner = text.replace(/\*+\/\s*$/, "");
  const lines = inner.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? "";
    if (line.trim() !== "") return line;
  }
  return "";
}
