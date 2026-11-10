import { describe, expect, it } from "vitest";
import { ignoredByC8 } from "../test/coverage.js";
import { hintsNextNode, monocartLines, opensRow, textHints } from "./coverage.js";
import { rowStartOffsets } from "./astgrep.js";
import { lineIndexAt } from "./lines.js";

// coverage.ts mirrors how the coverage tools that count lines read an
// `ignore next` hint. For c8 the tests run the real converter — v8-to-istanbul,
// a devDependency — so the mirror cannot drift from it silently. Node's test
// runner and monocart-coverage-reports are not installed here: what the tests
// expect of them is what `getLines` in Node 22's
// lib/internal/test_runner/coverage.js and `getIgnoredRanges` in monocart
// 3.2.1's lib/converter/ignore.js do with the same text, and of Vitest's v8
// provider what `getIgnoreHints` in ast-v8-to-istanbul 1.0.5 does.

/**
 * The rows (1-based) c8 ignores going by the mirror: the converter's loop over
 * the rows, fed the hints textHints finds and the counts opensRow lets them have.
 */
function rowsIgnoredForC8(source: string): number[] {
  const rows = rowStartOffsets(source);
  const hints = textHints(source);
  const ignored: number[] = [];
  let counted = 0;
  for (const [row, start] of rows.entries()) {
    // A final line feed ends the last row; it opens none.
    if (start === source.length) break;
    // The converter goes by the first hint of a row, and a hint sets the count anew.
    const hint = hints.find((candidate) => lineIndexAt(rows, candidate.offset) === row);
    if (counted > 0 || hint !== undefined) ignored.push(row + 1);
    counted = Math.max(0, counted - 1);
    if (hint !== undefined) counted = opensRow(source.slice(start, hint.offset)) ? hint.rows : 0;
  }
  return ignored;
}

describe("textHints and opensRow, against v8-to-istanbul", () => {
  it.each([
    "/* c8 ignore next */\na();\nb();\n",
    "/* v8 ignore next 2 */\na();\nb();\nc();\n",
    "/* node:coverage ignore next 3 */\na();\nb();\nc();\nd();\n",
    "a(); /* c8 ignore next */\nb();\nc();\n",
    "a(); /* c8 ignore next 2 */\nb();\nc();\n",
    "}); /* v8 ignore next 2 */\na();\nb();\nc();\n",
    "  \t/* c8 ignore next */\na();\nb();\n",
    "/* note */ /* c8 ignore next */\na();\nb();\n",
    "/**/ /* c8 ignore next 2 */\na();\nb();\nc();\n",
    "// TODO /* c8 ignore next */\na();\nb();\n",
    "// --- /* c8 ignore next */\na();\nb();\n",
    'const s = "/* c8 ignore next 2 */";\na();\nb();\n',
    "const t = `\n/* v8 ignore next */\n`;\na();\n",
    "/* c8 ignore next 2 extra words */\na();\nb();\nc();\n",
    "/* c8 ignore next 02 */\na();\nb();\nc();\n",
    "/* c8 ignore next 0 */\na();\nb();\n",
    "/* c8 ignore next -- reason */\na();\nb();\n",
    "/* c8 ignore next*/\na();\nb();\n",
    "/* c8 ignore nextline */\na();\nb();\n",
    "/* c8 ignore next 2*/\na();\nb();\nc();\n",
    "a();\r/* c8 ignore next */\nb();\nc();\n",
    " /* c8 ignore next */\na();\nb();\n",
    "/* c8 ignore next 2 */\r\na();\r\nb();\r\nc();\r\n",
    "/* c8 ignore next */\ra();\nb();\nc();\n",
    "/* c8 ignore next */",
    "/* c8 ignore next 5 */\na();\n",
    "/* c8 ignore next */ /* c8 ignore next 3 */\na();\nb();\nc();\n",
    "/* c8 ignore next 3 */\na(); /* c8 ignore next */\nb();\nc();\n",
    "/* c8 ignore next 3 */\n/* c8 ignore next */\na();\nb();\nc();\n",
  ])("finds the rows c8 ignores in %j", async (source) => {
    expect(rowsIgnoredForC8(source)).toEqual(await ignoredByC8(source));
  });

  it.each([
    "/* c8  ignore next */\na();\n",
    "/* c8 ignore  next */\na();\n",
    "/*c8 ignore next */\na();\n",
    "/** c8 ignore next */\na();\n",
    "// c8 ignore next\na();\n",
    "/* C8 ignore next */\na();\n",
    "/* istanbul ignore next */\na();\n",
    "/* c8 ignore\nnext */\na();\n",
  ])("finds no hint where c8 reads none, in %j", async (source) => {
    expect(textHints(source)).toEqual([]);
    expect(await ignoredByC8(source)).toEqual([]);
  });
});

describe("textHints, for Node's test runner", () => {
  it.each([
    ["/* node:coverage ignore next */\n", 1],
    ["/* node:coverage ignore next 3 */\n", 3],
    ["/* node:coverage ignore next 12 */\n", 12],
    ['const s = "/* node:coverage ignore next 2 */";\n', 2],
    // Node wants the whole comment, with one space on each side of the count.
    ["/* node:coverage ignore next 3*/\n", 0],
    ["/* node:coverage ignore next -- reason */\n", 0],
    ["/* node:coverage ignore next 3 lines */\n", 0],
    ["/* node:coverage ignore next", 0],
    // c8's and Vitest's spellings are not Node's.
    ["/* c8 ignore next */\n", 0],
    ["/* v8 ignore next 2 */\n", 0],
  ])("reads the rows Node ignores below %j", (source, nodeRows) => {
    expect(textHints(source).map((hint) => hint.nodeRows)).toEqual([nodeRows]);
  });

  it("reports where each hint stands and the count c8 reads behind it", () => {
    const source = "a(); /* c8 ignore next 2 */ /* node:coverage ignore next */\n/* v8 ignore next */\n";

    expect(textHints(source)).toEqual([
      { offset: 5, rows: 2, nodeRows: 0 },
      { offset: 28, rows: 1, nodeRows: 1 },
      { offset: 60, rows: 1, nodeRows: 0 },
    ]);
  });
});

describe("opensRow", () => {
  it.each(["", "  \t", "});", "}); // ", "/* */ ", "/**/", "'\"`", "\r", " ", "é", "/* é — */ "])(
    "takes %j for the start of a row, as v8-to-istanbul's `^\\W*` does",
    (prefix) => {
      expect(opensRow(prefix)).toBe(true);
    },
  );

  it.each(["a", "a(); ", "/* note */ ", "// 1 ", "_ ", "}); x"])("lets %j keep a hint from counting rows", (prefix) => {
    expect(opensRow(prefix)).toBe(false);
  });
});

describe("monocartLines", () => {
  it.each([
    ["/* c8 ignore next */", "", 1],
    ["/* v8 ignore next */", "", 1],
    ["/* node:coverage ignore next */", "", 1],
    ["// c8 ignore next", "", 1],
    ["// v8 ignore next 3", "", 3],
    ["/* c8 ignore next 2 */", "", 2],
    ["/* node:coverage ignore next 4 */", "", 4],
    ["/*c8 ignore next 2*/", "", 2],
    ["/** v8 ignore next 2 */", "", undefined],
    ["/*\n  c8 ignore\n  next\n  3\n*/", "", 3],
    // The leading integer of what follows `next` is the count.
    ["/* c8 ignore next3 */", "", 3],
    ["/* c8 ignore next 3x */", "", 3],
    ["/* c8 ignore next 2 -- legacy */", "", 2],
    // (monocart's parseInt takes no radix, so a hexadecimal count is one too.)
    ["/* c8 ignore next 0x10 */", "", 16],
    // Anything else there counts one line: no number, zero, a negative one.
    ["/* c8 ignore next -- legacy */", "", 1],
    ["/* c8 ignore next 0 */", "", 1],
    ["/* c8 ignore next -2 */", "", 1],
    // A block comment something follows on its line is for that, and covers no line below.
    ["/* c8 ignore next */", " a();", 0],
    ["/* c8 ignore next */", "  \t", 1],
    ["/* c8 ignore next 2 */", " a();", 2],
    ["// c8 ignore next", "", 1],
  ] as const)("counts the lines below %j followed by %j", (text, trailing, lines) => {
    expect(monocartLines(text.startsWith("//") ? "line" : "block", text, trailing)).toBe(lines);
  });

  it.each([
    "/* istanbul ignore next */",
    "/* c8  ignore next */",
    "/* C8 ignore next */",
    "/* see c8 ignore next */",
    "/* c8 ignore start */",
    "/* c8 ignore */",
    "/* v8 ignore if */",
    "/* node:coverage disable */",
    "/* node:coverage next */",
    "// node:coverage",
  ])("reads no `ignore next` from %j", (text) => {
    expect(monocartLines(text.startsWith("//") ? "line" : "block", text, "")).toBeUndefined();
  });
});

describe("hintsNextNode", () => {
  it.each([
    "/* c8 ignore next */",
    "/* v8 ignore next 3 */",
    "/* istanbul ignore next */",
    "/* istanbul ignore if */",
    "/* v8 ignore else */",
    "/* node:coverage ignore next */",
    "// c8 ignore next",
    "//v8 ignore next -- reason",
    "/*c8 ignore next*/",
    "/** c8 ignore next */",
    "/* c8   ignore\n   next */",
    "/* c8 ignore next: reason */",
  ])("reads a hint for the next node from %j", (text) => {
    expect(hintsNextNode(text)).toBe(true);
  });

  it.each([
    "// see /* c8 ignore next */",
    "/* see c8 ignore next */",
    "/* c8 ignore next3 */",
    "/* c8 ignore nextLine */",
    "/* c8 ignore start */",
    "/* c8 ignore file */",
    "/*** c8 ignore next */",
    "/**\n * c8 ignore next\n */",
    "//// c8 ignore next",
    "/* C8 ignore next */",
    "/**/",
  ])("reads none from %j", (text) => {
    expect(hintsNextNode(text)).toBe(false);
  });
});
