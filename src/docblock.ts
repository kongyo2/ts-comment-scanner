/**
 * The pragma keys of a docblock, read the way jest-docblock (v30.5.0, the
 * version prettier main pins) reads them. Prettier's `--require-pragma` and
 * `--check-ignore-pragma` modes run the file's leading docblock through
 * jest-docblock (prettier `src/language-js/pragma.js`), so the regexes below
 * are jest-docblock's own and its quirks carry over:
 *
 * - `/*` single-star comments are docblocks too (`\/\*\*?`).
 * - The gutter strip removes spaces, ONE star and one optional space per line
 *   (`(\r?\n|^) *\* ?`), so a tab before the star, or a doubled star, leaves
 *   the line's `@` off the line start and the pragma unrecognised.
 * - Only spaces may precede the `@`; a tab defeats it as well.
 * - The docblock regex spells line breaks as `\r?\n`, so a U+2028 or U+2029
 *   anywhere in the comment stops it from being extracted at all.
 *
 * Prettier normalises CR and CRLF to LF before parsing (`normalizeEndOfLine`
 * in `src/common/end-of-line.js`), and so does this port. jest-docblock's
 * remaining steps — folding a value continued on the next line into its key
 * and trimming the text — only shape the values, never which keys exist: a
 * continuation line starts with something other than `@`, so it was never a
 * key, and the key line it joins stays a key. They are left out, which also
 * spares long docblocks the one-pass-per-continuation-line loop.
 */
const DOCBLOCK = /^\s*(\/\*\*?(.|\r?\n)*?\*\/)/;
const COMMENT_START = /^\/\*\*?/;
const COMMENT_END = /\*\/$/;
const GUTTER = /(\r?\n|^) *\* ?/g;
const PROPERTY = /(?:^|\r?\n) *@(\S+) *([^\n\r]*)/g;

/**
 * The pragma keys of the docblock that opens the text (`format` for a
 * `@format` line), in order of first appearance, or an empty list when the
 * text does not open with a docblock jest-docblock would extract.
 */
export function docblockPragmas(text: string): string[] {
  const match = DOCBLOCK.exec(text.replaceAll(/\r\n?/g, "\n"));
  if (!match) return [];
  const docblock = (match[0] as string)
    .trimStart()
    .replace(COMMENT_START, "")
    .replace(COMMENT_END, "")
    .replaceAll(GUTTER, "$1");
  const keys: string[] = [];
  for (const property of docblock.matchAll(PROPERTY)) {
    const key = property[1] as string;
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}
