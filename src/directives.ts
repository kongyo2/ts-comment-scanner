import type { CommentKind } from "./types.js";

interface DirectiveRule {
  pattern: RegExp;
  /** Fixed name, or derive it from the match. Defaults to the full matched text. */
  name?: string | ((match: RegExpExecArray) => string);
  blockOnly?: boolean;
}

const RULES: DirectiveRule[] = [
  // TypeScript compiler (block form; the line form is matched on the raw text
  // with TS_LINE_DIRECTIVE, since TS only honours `//` or `///` markers)
  { pattern: /^@ts-(?:ignore|expect-error|nocheck|check)\b/, blockOnly: true },
  // ESLint
  { pattern: /^eslint-(?:disable|enable)(?:-next-line|-line)?\b/ },
  { pattern: /^eslint-env\b/ },
  { pattern: /^eslint\s+\S/, name: "eslint", blockOnly: true },
  { pattern: /^(globals?|exported)\s+\S/, name: (match) => match[1] ?? "global", blockOnly: true },
  // TSLint (legacy)
  { pattern: /^tslint:[a-z-]+/ },
  // oxlint
  { pattern: /^oxlint-(?:disable|enable)(?:-next-line|-line)?\b/ },
  // Biome
  { pattern: /^biome-ignore(?:-all|-start|-end)?\b/ },
  // Deno
  { pattern: /^deno-(?:lint-ignore(?:-file)?|fmt-ignore(?:-file)?|coverage-ignore(?:-file|-start|-stop)?)\b/ },
  // Prettier
  { pattern: /^prettier-ignore(?:-start|-end)?\b/ },
  // Coverage tools
  { pattern: /^istanbul\s+ignore\b/, name: "istanbul-ignore" },
  { pattern: /^c8\s+ignore\b/, name: "c8-ignore" },
  { pattern: /^v8\s+ignore\b/, name: "v8-ignore" },
  { pattern: /^node:coverage\s+(?:disable|enable|ignore)\b/, name: "node:coverage" },
  // Bundlers
  { pattern: /^webpack[A-Z][A-Za-z]*\s*:/, name: "webpack-magic-comment" },
  { pattern: /^@vite-ignore\b/ },
  { pattern: /^[#@]__(?:PURE|NO_SIDE_EFFECTS|INLINE|NOINLINE)__/ },
  // Source maps (`//# sourceMappingURL=`, legacy `//@`, and the block form)
  { pattern: /^[#@]\s*(source(?:Mapping)?URL)=/, name: (match) => match[1] ?? "sourceMappingURL" },
  // JSX pragmas
  { pattern: /^@jsx(?:Runtime|ImportSource|Frag)?\b/ },
  // Test runners
  { pattern: /^@(?:jest|vitest)-environment\b/ },
  // Editor folding
  { pattern: /^#(?:region|endregion)\b/ },
];

const TRIPLE_SLASH = /^\/\/\/\s*<(reference|amd-dependency|amd-module)\b/;

// Mirrors the TypeScript compiler's own comment-directive matching: exactly
// two or three slashes, optional whitespace, then the directive.
const TS_LINE_DIRECTIVE = /^\/\/\/?\s*@ts-(ignore|expect-error|nocheck|check)\b/;

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
    const tsDirective = TS_LINE_DIRECTIVE.exec(text);
    if (tsDirective) {
      return `@ts-${tsDirective[1]}`;
    }
  }

  const content = leadingContent(kind, text);
  for (const rule of RULES) {
    if (rule.blockOnly === true && kind !== "block") continue;
    const match = rule.pattern.exec(content);
    if (!match) continue;
    if (typeof rule.name === "string") return rule.name;
    if (typeof rule.name === "function") return rule.name(match);
    return match[0];
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
 * First non-empty content line of the comment, with comment markers stripped.
 * For line comments only the `//` marker itself is removed: extra slashes are
 * content, so a commented-out directive like `//// @ts-ignore` stays ordinary.
 */
function leadingContent(kind: CommentKind, text: string): string {
  const inner = kind === "line" ? text.replace(/^\/\//, "") : text.replace(/^\/\*+/, "").replace(/\*+\/\s*$/, "");
  for (const line of inner.split(/\r?\n/)) {
    const stripped = line.replace(/^\s*\*+\s*/, "").trim();
    if (stripped !== "") return stripped;
  }
  return "";
}
